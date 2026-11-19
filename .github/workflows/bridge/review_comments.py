"""Mirror submitted PR discussions before merging the destination PR."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import re

from api import ApiError, BridgeError, same_account


HUNK = re.compile(r'^@@ -[0-9]+(?:,[0-9]+)? \+([0-9]+)(?:,([0-9]+))? @@')


def right_lines(patch):
    """Only count right-side lines actually present in a published diff hunk."""
    lines = {}
    current, remaining = 0, 0
    for row in patch.split('\n'):
        match = HUNK.match(row)
        if match:
            current = int(match[1])
            remaining = int(match[2]) if match[2] is not None else 1
        elif remaining and row.startswith((' ', '+')):
            lines[current] = row[1:]
            current += 1
            remaining -= 1
    return lines


@dataclass
class SourceComment:
    key: str
    time: datetime
    user: dict | None
    body: str
    candidate: dict | None = None  # A single RIGHT line still needs matching source and target diffs.


def source_comment(row, prefix, body, candidate=None):
    user, source_id = row.get('user'), str(row.get('id'))
    if (not source_id.isdecimal() or 'user' not in row or not isinstance(body, str)
            or (user is not None and (not isinstance(user, dict) or not str(user.get('id')).isdecimal()))):
        raise BridgeError('GitHub returned an incomplete PR comment')
    stamp = row.get('submitted_at' if prefix == 'review:' else 'created_at')
    try:
        time = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
        if time.tzinfo is None:
            raise ValueError
    except (AttributeError, ValueError) as error:
        raise BridgeError(f'Invalid GitHub comment timestamp for {prefix}{source_id}') from error
    return SourceComment(prefix + source_id, time, user, body, candidate)


def located_body(row, label=''):
    # A Git path can contain a newline or a backtick. Keep it in one Markdown code span on one line.
    path = row['path'].replace('\r', r'\r').replace('\n', r'\n')
    fence = '`' * (1 + max(map(len, re.findall(r'`+', path)), default=0))
    pad = ' ' if path.startswith(('`', ' ')) or path.endswith(('`', ' ')) else ''
    return f'> {fence}{pad}{path}{pad}{fence}{label}\n\n{row["body"]}'


def outdated_body(row):
    original = row.get('original_line')
    label = f' · 原第 {original} 行' if type(original) is int and original > 0 else ''
    side = row.get('side')
    if side in ('LEFT', 'RIGHT'):
        label += ' · ' + side
    return located_body(row, label + ' · 已过时/无法挂行')


def review_root(row):
    if not isinstance(row.get('path'), str) or not row['path'] or not isinstance(row.get('body'), str):
        raise BridgeError('GitHub returned a review comment without a path or body')
    subject, side, line = row.get('subject_type', 'line'), row.get('side'), row.get('line')
    start, start_side = row.get('start_line'), row.get('start_side') or side
    if subject == 'file':
        body = located_body(row)
    elif (subject != 'line' or type(line) is not int or line < 1
          or row.get('position', 1) is None or row.get('outdated') or row.get('is_outdated')
          or side not in ('LEFT', 'RIGHT') or start_side not in ('LEFT', 'RIGHT')
          or (start is not None and (type(start) is not int or start < 1))):
        body = outdated_body(row)
    elif side == 'RIGHT' and start_side == side and start in (None, line):
        return source_comment(row, '', row['body'], candidate=row)
    else:
        location = f'{side} L{line}'
        if start is not None and (start != line or start_side != side):
            location = f'{start_side} L{start} – {location}'
        elif start_side != side:
            location = f'{start_side} – {location}'
        body = located_body(row, ' · ' + location)
    return source_comment(row, '', body)


def read_comments(api, number):
    comments, pending_reviews = [], set()
    replies = 0
    for row in api.pages(f'/issues/{number}/comments'):
        body = row.get('body')
        if body and body.strip():
            comments.append(source_comment(row, 'issue:', body))
    for row in api.pages(f'/pulls/{number}/reviews'):
        state, body = row['state'].upper(), row.get('body') or ''
        if state == 'PENDING':
            pending_reviews.add(str(row['id']))
            continue
        if state == 'COMMENTED':
            if not body.strip():
                continue
        elif state in ('APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'):
            body = f'**{state}**' + ('\n\n' + body if body.strip() else '')
        else:
            raise BridgeError(f'Unknown GitHub review state {state}')
        comments.append(source_comment(row, 'review:', body))
    for row in api.pages(f'/pulls/{number}/comments'):
        if row.get('in_reply_to_id') is not None:
            replies += 1
        elif str(row.get('pull_request_review_id')) not in pending_reviews:
            comments.append(review_root(row))
    # All three endpoints have independent IDs and ordering. Break timestamp ties consistently.
    return sorted(comments, key=lambda item: (item.time, item.key)), replies


def review_files(api, pr_path, wanted, *, destination=False):
    files = {}
    for row in api.pages(pr_path + '/files'):
        path = row.get('filename')
        if path not in wanted:
            continue
        patch = row.get('patch')
        if destination and isinstance(patch, dict):
            if patch.get('too_large') or patch.get('deleted_file') or patch.get('new_path') != path:
                continue
            patch = patch.get('diff')
        blob = row.get('blob_id' if destination else 'sha')
        if isinstance(patch, str) and isinstance(blob, str) and re.fullmatch(r'[0-9a-f]{40}', blob):
            files[path] = (blob, right_lines(patch))
    return files


def exact_line(comment, source_files, target_files):
    path, line = comment['path'], comment['line']
    source, target = source_files.get(path), target_files.get(path)
    if not source or not target or source[0] != target[0]:
        return False
    return line in source[1] and line in target[1] and source[1][line] == target[1][line]


def plan_comments(bridge, number, comments, target_path):
    paths = {item.candidate['path'] for item in comments if item.candidate}
    source = review_files(bridge.github_api, f'/pulls/{number}', paths) if paths else {}
    target = review_files(bridge.target_api, target_path, paths, destination=True) if paths and target_path else {}
    for item in comments:
        row = item.candidate
        if row is None:
            yield item, 'pr', {'body': item.body}
        elif target_path is None and row['path'] in source and row['line'] in source[row['path']][1]:
            yield item, 'candidate', None  # A read-only preview cannot create the destination diff.
        elif exact_line(row, source, target):
            yield item, 'diff', {'body': item.body, 'path': row['path'], 'position': row['line'], 'position_type': 'text'}
        else:
            yield item, 'pr', {'body': outdated_body(row)}


def preview_comments(bridge, number, target_path=None, records=None):
    comments, replies = read_comments(bridge.github_api, number)
    records = records or {}
    fresh = [item for item in comments if item.key not in records]
    unconfirmed = sum(isinstance(record, dict) for record in records.values())
    counts = {'pr': 0, 'diff': 0, 'candidate': 0}
    for _, kind, _ in plan_comments(bridge, number, fresh, target_path):
        counts[kind] += 1
    print(f'REVIEW preview GitHub PR #{number} | pr_comment={counts["pr"]}, diff_comment={counts["diff"]}, '
          f'single-line candidates={counts["candidate"]} (pr_comment if unverified), '
          f'unconfirmed writes={unconfirmed}, replies ignored={replies}')


class CommentDelivery:
    """Keep a write intent and the verified destination note ID outside comment text."""

    def __init__(self, bridge, store, path):
        self.bridge, self.store, self.path = bridge, store, path
        self.number = path.rsplit('/', 1)[1]
        self.records = dict(store.review_comments.get(self.number, {}))

    def save(self, source_id, record):
        updated = dict(self.records)
        if record is None:
            updated.pop(source_id)
        else:
            updated[source_id] = record
        self.store.save(self.store.progress, review_comments={**self.store.review_comments, self.number: updated})
        self.records = updated

    def notes(self, kind):
        if kind not in ('diff', 'pr'):
            raise BridgeError('Unknown pending comment kind')
        return list(self.bridge.target_api.pages(self.path + '/comments', comment_type=kind + '_comment'))

    def matches_note(self, intent, note, note_id):
        payload = intent['payload']
        kind = intent.get('kind', 'diff')
        if (note.get('body') != payload['body'] or not same_account(note.get('user') or {}, intent['account'])
                or not note.get('discussion_id')):
            return False
        if kind == 'diff':
            line = payload['position']
            span = note.get('diff_position') or {}
            if span.get('end_new_line') != line or span.get('start_new_line') not in (None, line):
                return False
        elif note.get('comment_type') != 'pr_comment':
            return False
        if not re.fullmatch(r'[1-9][0-9]*', note_id):
            raise BridgeError('Destination returned an invalid comment ID')
        detail = self.bridge.target_api.call('GET', '/pulls/comments/' + note_id)
        if (str(detail.get('id')) != note_id or detail.get('discussion_id') != note['discussion_id']
                or detail.get('body') != payload['body']):
            return False
        if kind == 'pr':
            # The detail has an internal user ID. The scoped list supplies the mapped ID.
            login = (detail.get('user') or {}).get('login') or ''
            return not detail.get('position') and login.casefold() == intent['account']['username'].casefold()
        pos = detail.get('position') or {}
        return (not detail.get('is_outdated') and pos.get('position_type') == 'text'
                and pos.get('new_path') == payload['path'] and pos.get('new_line') == line
                and pos.get('head_sha') == self.store.progress['pending']['head'])

    def find_new(self, intent, notes):
        matches_found = set()
        before = set(intent['before']) | {saved for saved in self.records.values() if isinstance(saved, str)}
        handle = intent.get('handle')
        for note in notes:
            note_id = str(note['id'])
            if note_id in before or (handle and handle not in (note_id, str(note.get('discussion_id')))):
                continue
            if intent.get('note_id') and note_id != intent['note_id']:
                continue
            if self.matches_note(intent, note, note_id):
                matches_found.add(note_id)
        if len(matches_found) > 1:
            label = 'inline' if intent.get('kind', 'diff') == 'diff' else 'PR'
            raise BridgeError(f'Ambiguous {label} comment receipt. Check the pending record before retrying.')
        return next(iter(matches_found), None)

    def post(self, source_id, intent):
        kind = intent['kind']
        before = [str(note['id']) for note in self.notes(kind)]

        def publish(account, api):
            identity = {'id': account['id'], 'username': account['username']}
            attempt = {**intent, 'account': identity, 'before': before}
            self.save(source_id, attempt)
            try:
                response = api.call('POST', self.path + '/comments', attempt['payload'])
            except ApiError as error:
                # Clear only a definite rejection. Unknown outcomes keep the
                # actual account and original note list for reconciliation.
                if error.code in (400, 401, 403, 404, 405, 422):
                    self.save(source_id, None)
                raise
            return attempt, response

        intent, response = self.bridge.post_as(intent['account'], publish)
        handle = str(response.get('id') or '') if isinstance(response, dict) else ''
        intent = dict(intent, handle=handle)
        if isinstance(response, dict) and response.get('note_id') is not None:
            intent['note_id'] = str(response['note_id'])
        self.save(source_id, intent)
        found = self.find_new(intent, self.notes(kind))
        if not found:
            label = 'inline' if kind == 'diff' else 'PR'
            raise BridgeError(f'Could not confirm the {label} comment before merge. Check the pending receipt.')
        self.save(source_id, found)

    def recover(self):
        # Recover an interrupted write even if GitHub has since edited or removed the source comment.
        for source_id, record in list(self.records.items()):
            if isinstance(record, dict):
                found = self.find_new(record, self.notes(record.get('kind', 'diff')))
                if not found:
                    raise BridgeError(f'Comment {source_id} has an unconfirmed write. Check the '
                                      'receipt and the destination PR before authorizing another POST.')
                self.save(source_id, found)

    def run(self, original):
        number = str(original['number'])
        self.recover()
        comments, replies = read_comments(self.bridge.github_api, number)
        fresh = [item for item in comments if item.key not in self.records]
        if fresh:
            self.bridge.verify_pending_refs(self.store.progress['pending'])
            for item, kind, payload in plan_comments(self.bridge, number, fresh, self.path):
                if item.key not in self.records:
                    account = self.bridge.mapped_account(item.user)
                    self.post(item.key, {'kind': kind, 'account': account, 'payload': payload})
        print(f'REVIEW GitHub PR #{number} | confirmed {len(self.records)}, replies ignored {replies}')
