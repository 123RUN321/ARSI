import io
import sys
import unittest
from contextlib import redirect_stdout
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api import ApiError, BridgeError
from bridge import Bridge
from review_comments import CommentDelivery, plan_comments, preview_comments, read_comments


RAW = 'A **review**.\r\n\r\n- Keep `code`.  \n'
HEAD = 'a' * 40
MEMBER = {'id': 'member-account', 'username': 'reviewer'}
BOT = {'id': 'bot-account', 'username': 'robot'}


def comment(oid, minute, **fields):
    return dict({'id': oid, 'created_at': f'2026-11-01T12:{minute:02}:00Z',
                 'body': RAW, 'user': {'id': 7}}, **fields)


def review(oid, minute, state, body):
    row = comment(oid, minute, state=state, body=body)
    row['submitted_at'] = row.pop('created_at')
    return row


def root(oid, minute, **fields):
    return {**comment(oid, minute), 'path': 'file.py', 'side': 'RIGHT', 'line': 8, **fields}


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.source, self.target = Mock(), Mock()
        self.bridge = SimpleNamespace(github_api=self.source, target_api=self.target)
        self.rows = {'/issues/5/comments': [], '/pulls/5/reviews': [], '/pulls/5/comments': [],
                     '/pulls/5/files': [{'filename': 'file.py', 'sha': HEAD, 'patch': '@@ -8 +8 @@\n-old\n+new'}]}
        self.source.pages.side_effect = self.rows.__getitem__
        self.target.pages.return_value = [{'filename': 'file.py', 'blob_id': HEAD,
                                           'patch': {'new_path': 'file.py', 'diff': '@@ -8 +8 @@\n-old\n+new'}}]

    def test_orders_all_sources_by_instant_and_keeps_distinct_receipt_keys_and_markdown(self):
        self.rows['/issues/5/comments'] = [comment(7, 4), comment(50, 1, body=' \t\n'),
                                           comment(51, 1, body=None)]
        self.rows['/pulls/5/reviews'] = [
            review(7, 6, 'APPROVED', None), review(8, 2, 'CHANGES_REQUESTED', RAW),
            review(9, 7, 'COMMENTED', RAW), review(10, 1, 'COMMENTED', ' \r\n'),
            {'id': 11, 'state': 'PENDING', 'body': 'Draft'}, review(12, 9, 'DISMISSED', ''),
        ]
        self.rows['/pulls/5/comments'] = [
            root(15, 8, line=99, original_line=11), root(7, 3), root(13, 1, subject_type='file', line=None),
            root(14, 5, side='LEFT', created_at='2026-11-01T13:05:00+01:00'),
            root(16, 9, in_reply_to_id=7), root(17, 9, pull_request_review_id=11),
        ]
        comments, replies = read_comments(self.source, 5)
        plan = [(item.key, kind, payload) for item, kind, payload in plan_comments(self.bridge, 5, comments, '/pulls/24')]
        self.assertEqual(replies, 1)
        self.assertEqual(plan, [
            ('13', 'pr', {'body': '> `file.py`\n\n' + RAW}),
            ('review:8', 'pr', {'body': '**CHANGES_REQUESTED**\n\n' + RAW}),
            ('7', 'diff', {'body': RAW, 'path': 'file.py', 'position': 8, 'position_type': 'text'}),
            ('issue:7', 'pr', {'body': RAW}), ('14', 'pr', {'body': '> `file.py` · LEFT L8\n\n' + RAW}),
            ('review:7', 'pr', {'body': '**APPROVED**'}), ('review:9', 'pr', {'body': RAW}),
            ('15', 'pr', {'body': '> `file.py` · 原第 11 行 · RIGHT · 已过时/无法挂行\n\n' + RAW}),
            ('review:12', 'pr', {'body': '**DISMISSED**'}),
        ])

    def test_locations_for_ranges_outdated_rows_and_unverified_single_lines(self):
        self.rows['/pulls/5/comments'] = [
            root(1, 1, start_line=4), root(2, 2, start_line=3, start_side='LEFT'),
            root(3, 3, side='LEFT', line=None, original_line=10),
            root(4, 4, position=None), root(5, 5, path='unlisted`name.py', original_line=12),
            root(6, 6, subject_type='file', path='line\nbreak.txt'),
            root(7, 7, outdated=True, original_line=8),
        ]
        comments, _ = read_comments(self.source, 5)
        bodies = [p['body'] for _, kind, p in plan_comments(self.bridge, 5, comments, '/pulls/24') if kind == 'pr']
        self.assertEqual(bodies, [header + '\n\n' + RAW for header in [
            '> `file.py` · RIGHT L4 – RIGHT L8', '> `file.py` · LEFT L3 – RIGHT L8',
            '> `file.py` · 原第 10 行 · LEFT · 已过时/无法挂行', '> `file.py` · RIGHT · 已过时/无法挂行',
            '> ``unlisted`name.py`` · 原第 12 行 · RIGHT · 已过时/无法挂行', '> `line\\nbreak.txt`',
            '> `file.py` · 原第 8 行 · RIGHT · 已过时/无法挂行',
        ]])

    def test_preserves_bot_conversation_and_submitted_review_text(self):
        self.rows['/issues/5/comments'] = [comment(1, 1, user={'id': 42, 'type': 'Bot'})]
        self.rows['/pulls/5/reviews'] = [review(1, 2, 'APPROVED', RAW), review(2, 3, 'CHANGES_REQUESTED', ' \t'),
                                          review(3, 4, 'COMMENTED', None)]
        comments, _ = read_comments(self.source, 5)
        self.assertEqual([(c.key, c.body) for c in comments],
                         [('issue:1', RAW), ('review:1', '**APPROVED**\n\n' + RAW),
                          ('review:2', '**CHANGES_REQUESTED**')])
        self.assertEqual(comments[0].user['id'], 42)

    def test_preview_distinguishes_candidates_from_verified_lines_without_writes(self):
        self.rows['/issues/5/comments'] = [comment(7, 1)]
        self.rows['/pulls/5/comments'] = [root(7, 2), root(8, 3, line=99), root(9, 4, in_reply_to_id=7)]
        with redirect_stdout(io.StringIO()) as output:
            preview_comments(self.bridge, 5)
        self.assertIn('pr_comment=2, diff_comment=0, single-line candidates=1', output.getvalue())
        self.target.pages.assert_not_called()
        with redirect_stdout(io.StringIO()) as output:
            preview_comments(self.bridge, 5, '/pulls/24', {'issue:7': {'kind': 'pr'}})
        self.assertIn('pr_comment=1, diff_comment=1, single-line candidates=0', output.getvalue())
        self.assertIn('replies ignored=1', output.getvalue())
        self.assertIn('unconfirmed writes=1', output.getvalue())
        self.target.call.assert_not_called()


class ReceiptStore:
    def __init__(self, records=None):
        self.progress = {'pending': {'head': HEAD}}
        self.review_comments = {'24': records or {}}

    def save(self, progress, *, review_comments):
        self.review_comments = deepcopy(review_comments)


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.bridge = Bridge.__new__(Bridge)
        self.bridge.bot, self.bridge.target_api = BOT, Mock()
        self.api = self.bridge.target_api
        self.member_api = Mock()
        self.bridge.verified_members = {MEMBER['id']: (MEMBER, self.member_api)}
        self.bridge.member_secrets, self.bridge.unavailable_members = {}, set()
        self.store = ReceiptStore()
        self.intent = {'kind': 'pr', 'account': MEMBER, 'before': [], 'payload': {'body': RAW}}
        self.note = {'id': 123, 'discussion_id': 'discussion', 'comment_type': 'pr_comment', 'body': RAW,
                     'user': {'id': MEMBER['id'], 'login': MEMBER['username']}}
        # GitCode details return an internal user ID and omit comment_type and position for ordinary notes.
        self.detail = {'id': 123, 'discussion_id': 'discussion', 'body': RAW,
                       'user': {'id': '24680', 'login': MEMBER['username']}}

    def delivery(self):
        return CommentDelivery(self.bridge, self.store, '/pulls/24')

    def test_ordinary_comment_uses_the_speaker_and_keeps_an_existing_bare_receipt(self):
        self.store = ReceiptStore({'7': '120'})
        self.bridge.mapping = {'7': MEMBER}
        self.bridge.github_api, self.bridge.verify_pending_refs = Mock(), Mock()
        self.bridge.github_api.pages.side_effect = {
            '/issues/5/comments': [comment(7, 1)], '/pulls/5/reviews': [], '/pulls/5/comments': [],
        }.__getitem__
        existing = dict(self.note, id=121, discussion_id='existing')
        self.api.pages.side_effect = [[existing], [existing, self.note]]
        self.api.call.return_value = self.detail
        self.member_api.call.return_value = {'id': 'discussion', 'note_id': 123, 'body': RAW}
        with redirect_stdout(io.StringIO()):
            self.delivery().run({'number': 5})
            self.delivery().run({'number': 5})
        self.member_api.call.assert_called_once_with('POST', '/pulls/24/comments', {'body': RAW})
        self.api.call.assert_called_once_with('GET', '/pulls/comments/123')
        self.assertEqual(self.store.review_comments['24'], {'7': '120', 'issue:7': '123'})

    def test_rejected_member_then_lost_robot_response_recovers_one_write(self):
        self.member_api.call.side_effect = ApiError('gitcode', 403)
        self.note['user'] = {'id': BOT['id'], 'login': BOT['username']}
        self.detail['user']['login'] = BOT['username']
        self.api.pages.side_effect = [[], [self.note]]
        self.api.call.side_effect = [BridgeError('lost response'), self.detail]
        with self.assertRaisesRegex(BridgeError, 'lost response'), redirect_stdout(io.StringIO()):
            self.delivery().post('issue:7', self.intent)
        self.member_api.call.assert_called_once_with('POST', '/pulls/24/comments', {'body': RAW})
        self.api.call.assert_called_once_with('POST', '/pulls/24/comments', {'body': RAW})
        pending = self.store.review_comments['24']['issue:7']
        self.assertEqual((pending['kind'], pending['account']), ('pr', BOT))
        self.delivery().recover()
        self.delivery().recover()
        self.assertEqual(self.store.review_comments['24'], {'issue:7': '123'})
        for args in self.api.pages.call_args_list:
            self.assertEqual(args.kwargs, {'comment_type': 'pr_comment'})
        self.assertEqual(self.api.call.call_count, 2)

    def test_unknown_member_outcome_never_falls_back_and_ambiguous_writes_pause(self):
        self.api.pages.return_value = []
        self.member_api.call.side_effect = BridgeError('lost response')
        with self.assertRaisesRegex(BridgeError, 'lost response'):
            self.delivery().post('review:7', self.intent)
        with self.assertRaisesRegex(BridgeError, 'unconfirmed write'):
            self.delivery().recover()
        self.api.call.assert_not_called()
        self.api.pages.return_value = [self.note, dict(self.note, id=124, discussion_id='other')]
        self.api.call.side_effect = [self.detail, dict(self.detail, id=124, discussion_id='other')]
        with self.assertRaisesRegex(BridgeError, 'Ambiguous PR comment'):
            self.delivery().recover()
        self.member_api.call.assert_called_once()
        self.assertIsInstance(self.store.review_comments['24']['review:7'], dict)

    def test_closed_pr_rejection_clears_only_the_failed_intent(self):
        self.store = ReceiptStore({'7': '120'})
        self.api.pages.return_value = []
        self.member_api.call.side_effect = ApiError('gitcode', 405)
        with self.assertRaises(ApiError):
            self.delivery().post('issue:7', self.intent)
        self.assertEqual(self.store.review_comments['24'], {'7': '120'})
        self.api.call.assert_not_called()

    def test_pr_receipt_requires_a_new_matching_note_from_both_reads(self):
        delivery = self.delivery()
        intent = dict(self.intent, before=['122'], handle='discussion', note_id='123')
        for note in [dict(self.note, id=122), dict(self.note, comment_type='diff_comment'),
                     dict(self.note, id=124), dict(self.note, discussion_id='unrelated'),
                     dict(self.note, body=RAW.strip()), dict(self.note, user={'id': 'other', 'login': 'reviewer'})]:
            with self.subTest(note=note):
                self.assertIsNone(delivery.find_new(intent, [note]))
        self.api.call.assert_not_called()
        for detail in [dict(self.detail, discussion_id='other'), dict(self.detail, body=RAW.strip()),
                       dict(self.detail, id=124), dict(self.detail, user={'login': 'other'}),
                       dict(self.detail, position={'new_line': 8})]:
            with self.subTest(detail=detail):
                self.api.call.return_value = detail
                self.assertIsNone(delivery.find_new(intent, [self.note]))
        self.api.call.return_value = self.detail
        self.assertEqual(delivery.find_new(intent, [self.note]), '123')

    def test_legacy_bare_receipts_and_pending_intents_default_to_diff(self):
        pending = {'account': MEMBER, 'before': [], 'payload': {'body': RAW, 'position': 8, 'path': 'file.py'}}
        self.store = ReceiptStore({'6': '120', '7': pending})
        self.api.pages.return_value = [dict(self.note, comment_type='diff_comment',
                                            diff_position={'start_new_line': 8, 'end_new_line': 8})]
        self.api.call.return_value = dict(self.detail, position={'head_sha': HEAD, 'position_type': 'text',
                                                                 'new_path': 'file.py', 'new_line': 8})
        self.delivery().recover()
        self.api.pages.assert_called_once_with('/pulls/24/comments', comment_type='diff_comment')
        self.assertEqual(self.store.review_comments['24'], {'6': '120', '7': '123'})
