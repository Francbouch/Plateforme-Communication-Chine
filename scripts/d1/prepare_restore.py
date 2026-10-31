"""Prepare a D1 SQL export for restoration into a DISTINCT EMPTY test database.

D1 exports can emit unique indexes after data that already references them.
Create all tables/indexes first and restore original triggers last. No DB/network
access, no disabled constraints, no changes to the source backup.
"""
import argparse
import hashlib
from pathlib import Path
import re
import sqlite3


def prepare_export(sql):
    groups = {key: [] for key in ('tables', 'indexes', 'data', 'views', 'triggers')}
    pending = ''
    for char in sql:
        pending += char
        if char != ';' or not sqlite3.complete_statement(pending):
            continue
        statement = pending.strip()
        pending = ''
        # Wrangler exports do not require executable comments.
        check = re.sub(r'^\s*(?:--[^\n]*(?:\n|$)\s*)+', '', statement).strip()
        if not check:
            continue
        if re.fullmatch(r'PRAGMA\s+defer_foreign_keys\s*=\s*(?:TRUE|ON|1)\s*;', check, re.I):
            continue
        if re.match(r'^CREATE TABLE\b', check, re.I):
            groups['tables'].append(statement)
        elif re.match(r'^CREATE (?:UNIQUE )?INDEX\b', check, re.I):
            groups['indexes'].append(statement)
        elif re.match(r'^CREATE TRIGGER\b', check, re.I):
            groups['triggers'].append(statement)
        elif re.match(r'^CREATE VIEW\b', check, re.I):
            groups['views'].append(statement)
        elif re.match(r'^INSERT INTO\b', check, re.I) or re.fullmatch(r'DELETE FROM ["`]?sqlite_sequence["`]?\s*;', check, re.I):
            groups['data'].append(statement)
        elif re.fullmatch(r'ANALYZE sqlite_schema\s*;', check, re.I):
            continue
        else:
            raise ValueError('Unsupported export statement; inspect the backup before restoring')
    if pending.strip():
        raise ValueError('Incomplete export statement')
    if not groups['tables']:
        raise ValueError('A complete schema export is required')
    return 'PRAGMA defer_foreign_keys=TRUE;\n' + '\n'.join(s for group in groups.values() for s in group) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    source = args.backup.read_bytes()
    prepared = prepare_export(source.decode('utf-8'))
    # Exclusive creation prevents accidental overwrite of any existing backup.
    with args.output.open('x', encoding='utf-8') as output:
        output.write(prepared)
    print('Source SHA-256:', hashlib.sha256(source).hexdigest())
    print('Prepared SHA-256:', hashlib.sha256(prepared.encode()).hexdigest())
    print('Prepared locally; no database was accessed. Restore only into a distinct empty test database.')


if __name__ == '__main__':
    main()
