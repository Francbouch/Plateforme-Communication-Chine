import sqlite3
import unittest
from migrate import MIGRATIONS, ROOT, SCHEMA, plan, migrate
from unittest.mock import patch


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.files = sorted(MIGRATIONS.glob('*.sql'))

    def tearDown(self):
        self.db.close()

    def apply(self, count):
        for file in self.files[:count]:
            self.db.executescript(file.read_text())

    def inspect(self, recorded=()):
        return plan(self.db.execute(SCHEMA), list(recorded))

    def test_empty(self):
        self.assertEqual(self.inspect(), ([], [f.name for f in self.files]))

    def test_manual_four_and_missing_five_preserve_data(self):
        self.apply(4)
        self.db.execute("INSERT INTO profiles(id,name) VALUES('sentinel','Preserved')")
        adopt, pending = self.inspect([f.name for f in self.files[:2]])
        self.assertEqual(adopt, [f.name for f in self.files[2:4]])
        self.assertEqual(pending, [f.name for f in self.files[4:]])
        
        for file in self.files[4:]:
            self.db.executescript(file.read_text())
        self.assertEqual(self.inspect([f.name for f in self.files]), ([], []))
        self.assertEqual(self.db.execute('SELECT name FROM profiles').fetchone()[0], 'Preserved')
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(), [])

    def test_all_manual_schema_only_prefixes(self):
        for count in range(1, 5):
            with self.subTest(count=count):
                db = sqlite3.connect(':memory:')
                db.row_factory = sqlite3.Row
                for file in self.files[:count]:
                    db.executescript(file.read_text())
                self.assertEqual(plan(db.execute(SCHEMA), [])[0], [f.name for f in self.files[:count]])
                db.close()

    def test_documented_dashboard_baseline_then_manual_four(self):
        self.db.executescript((ROOT / 'scripts/initialize-empty-d1.sql').read_text())
        for file in self.files[2:4]:
            self.db.executescript(file.read_text())
        self.assertEqual(self.inspect([f.name for f in self.files[:2]]),
                         ([f.name for f in self.files[2:4]], [f.name for f in self.files[4:]]))

    def test_partial_migration(self):
        self.apply(3)
        self.db.execute('ALTER TABLE documents ADD COLUMN review_counter INTEGER NOT NULL DEFAULT 0')
        with self.assertRaisesRegex(ValueError, 'partial schema'):
            self.inspect()

    def test_missing_protection_trigger(self):
        self.apply(4)
        self.db.execute('DROP TRIGGER revision_no_delete')
        with self.assertRaises(ValueError):
            self.inspect()

    def test_incorrect_column_constraint(self):
        self.apply(1)
        self.db.execute('ALTER TABLE profiles ADD COLUMN email TEXT')
        self.db.execute('CREATE UNIQUE INDEX profiles_verified_email ON profiles(email) WHERE email IS NOT NULL')
        with self.assertRaises(ValueError):
            self.inspect()

    def test_future_unknown_and_duplicate_ledger(self):
        self.apply(4)
        for recorded in ([f.name for f in self.files[4:]], ['unknown.sql'], [self.files[0].name] * 2):
            with self.subTest(recorded=recorded), self.assertRaises(ValueError):
                self.inspect(recorded)

    def test_untracked_five_needs_data_audit(self):
        self.apply(5)
        with self.assertRaisesRegex(ValueError, 'data migration'):
            self.inspect([f.name for f in self.files[:4]])

    def test_extra_object_refused(self):
        self.apply(4)
        self.db.execute('CREATE TABLE unexpected(id TEXT)')
        with self.assertRaises(ValueError):
            self.inspect()


class SecurityGateTests(unittest.TestCase):
    class Remote:
        target = '--remote'
        writes = []
        def inspect(self):
            return [], ['0009_secure_collaboration.sql']
        def query(self, sql):
            self.writes.append(sql)
        def run(self, *args):
            self.writes.append(args)

    def test_phase_seven_refuses_remote_writes_without_review_and_backup(self):
        runner = self.Remote()
        with patch.dict('os.environ', {}, clear=True):
            with self.assertRaisesRegex(ValueError, 'No writes performed'):
                migrate(runner, apply=True)
        self.assertEqual(runner.writes, [])

    def test_phase_seven_read_only_inspection_needs_no_approval(self):
        runner = self.Remote()
        with patch.dict('os.environ', {}, clear=True):
            migrate(runner, apply=False)
        self.assertEqual(runner.writes, [])

    def test_reviewed_remote_gate_allows_existing_runner_and_verifies_afterwards(self):
        class Reviewed(self.Remote):
            persist_args = []
            writes = []
            done = False
            def inspect(self):
                return ([], []) if self.done else ([], ['0009_secure_collaboration.sql'])
            def run(self, *args):
                self.writes.append(args)
                self.done = True
                return 'Test-only simulated migration runner'
        runner = Reviewed()
        with patch.dict('os.environ', {'PHASE7_SECURITY_REVIEWED': 'true', 'PHASE7_BACKUP_PROOF': 'a' * 64}, clear=True):
            migrate(runner, apply=True)
        self.assertTrue(runner.done)


if __name__ == '__main__':
    unittest.main()
