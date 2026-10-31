import sqlite3
import unittest
from prepare_restore import prepare_export


class RestoreTests(unittest.TestCase):
    def test_restores_referenced_unique_indexes_before_data_and_original_triggers_after_data(self):
        raw = '''PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE revisions(id TEXT,document_id TEXT);
INSERT INTO revisions VALUES('revision','document');
CREATE TABLE points(id TEXT,document_id TEXT,revision_id TEXT,body TEXT,FOREIGN KEY(document_id,revision_id) REFERENCES revisions(document_id,id));
INSERT INTO points VALUES('point','document','revision','Preserved; quote '' and newline
content');
CREATE UNIQUE INDEX revision_identity ON revisions(document_id,id);
CREATE TRIGGER immutable BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT,'preserved; immutable'); END;'''
        with sqlite3.connect(':memory:') as db:
            db.execute('PRAGMA foreign_keys=ON')
            with self.assertRaisesRegex(sqlite3.OperationalError, 'foreign key mismatch'):
                db.executescript(raw)
        with sqlite3.connect(':memory:') as db:
            db.execute('PRAGMA foreign_keys=ON')
            db.executescript(prepare_export(raw))
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
            self.assertIn('Preserved; quote', db.execute('SELECT body FROM points').fetchone()[0])
            with self.assertRaisesRegex(sqlite3.IntegrityError, 'preserved; immutable'):
                db.execute('DELETE FROM revisions')

    def test_rejects_unknown_or_partial_sql_instead_of_dropping_protections(self):
        for raw in ['PRAGMA foreign_keys=OFF;', 'DROP TABLE profiles;', 'CREATE TABLE a(id); INSERT INTO a VALUES(1)', 'INSERT INTO a VALUES(1);']:
            with self.assertRaises(ValueError):
                prepare_export(raw)


if __name__ == '__main__':
    unittest.main()
