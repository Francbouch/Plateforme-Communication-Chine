#!/usr/bin/env python3
"""Fail-closed D1 reconciliation. Run from the repository root; no R2 operations."""
import argparse
import json
from pathlib import Path
import re
import sqlite3
import subprocess

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'apps/api/migrations'
SCHEMA = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name"
LEDGER = "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)"


def canonical(sql):
    # Preserve strings and quoted identifiers exactly; ignore only external whitespace.
    return ''.join(re.findall(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|`[^`]*`|\[[^]]*\]|[^\s]", sql)).rstrip(';')


def schema(rows):
    return {(r['type'], r['name']): canonical(r['sql']) for r in rows
            if r['name'] != 'd1_migrations'
            and not r['name'].startswith(('sqlite_', '_cf_'))}


def references():
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    states = [[schema(db.execute(SCHEMA))]]
    files = sorted(MIGRATIONS.glob('*.sql'))
    for file in files:
        db.executescript(file.read_text())
        states.append([schema(db.execute(SCHEMA))])
    # The documented dashboard baseline places profiles.email second rather than last.
    # Accept that exact historical schema too; never relax constraints or triggers.
    db.close()
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    db.executescript((ROOT / 'scripts/initialize-empty-d1.sql').read_text())
    for version in range(2, len(files) + 1):
        states[version].append(schema(db.execute(SCHEMA)))
        if version < len(files):
            db.executescript(files[version].read_text())
    db.close()
    return [f.name for f in files], states


def plan(rows, recorded):
    files, states = references()
    actual = schema(rows)
    matches = [i for i, state in enumerate(states) if actual in state]
    if len(matches) != 1:
        raise ValueError('Unknown or partial schema: stop; inspect D1 without resetting it.')
    version = matches[0]
    if len(recorded) != len(set(recorded)) or any(name not in files[:version] for name in recorded):
        raise ValueError('Migration ledger contradicts schema or contains unknown/duplicate entries.')
    missing = [name for name in files[:version] if name not in recorded]
    # 0005 includes a data backfill. Schema alone cannot prove it completed.
    if any(name >= '0005' for name in missing):
        raise ValueError('Untracked data migration: manual data audit required; do not mark it automatically.')
    return missing, files[version:]


class Wrangler:
    def __init__(self, remote, persist_to=None):
        self.persist_args = ['--persist-to', str(persist_to)] if persist_to else []
        if remote and persist_to:
            raise ValueError('--persist-to is local-only')
        self.target = '--remote' if remote else '--local'

    def run(self, *args):
        result = subprocess.run(['npx', '--no-install', 'wrangler', 'd1', *args],
                                cwd=ROOT / 'apps/api', text=True, check=True,
                                stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE)
        return result.stdout

    def query(self, sql):
        results = json.loads(self.run('execute', 'forgebridge-db', self.target,
                                     '--command', sql, '--json', *self.persist_args))
        if not results or any(r.get('success') is not True for r in results):
            raise ValueError('D1 did not confirm query success.')
        return results[-1]['results']

    def inspect(self):
        rows = self.query(SCHEMA)
        ledger = any(r['name'] == 'd1_migrations' for r in rows)
        recorded = [r['name'] for r in self.query('SELECT name FROM d1_migrations ORDER BY id')] if ledger else []
        if self.query('PRAGMA foreign_key_check'):
            raise ValueError('Foreign-key violations: stop before writing.')
        if self.query('PRAGMA quick_check') != [{'quick_check': 'ok'}]:
            raise ValueError('Integrity check failed.')
        return plan(rows, recorded)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--remote', action='store_true')
    parser.add_argument('--apply', action='store_true', help='Without this flag, inspect only')
    parser.add_argument('--persist-to', type=Path, help='Isolated local D1 storage directory')
    args = parser.parse_args()
    migrate(Wrangler(args.remote, args.persist_to), args.apply)


def migrate(runner, apply=False):
    adopt, pending = runner.inspect()
    print(json.dumps({'recognize_manual': adopt, 'apply': pending}))
    if not apply:
        return
    # Only bookkeeping for fully matched, schema-only migrations. Safe to retry.
    runner.query(LEDGER)
    for name in adopt:
        runner.query("INSERT INTO d1_migrations(name) SELECT '" + name + "' WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name='" + name + "')")
    # Wrangler applies each pending migration transactionally with its ledger entry.
    print(runner.run('migrations', 'apply', 'forgebridge-db', runner.target, *runner.persist_args))
    adopt, pending = runner.inspect()
    if adopt or pending:
        raise ValueError('Post-migration verification failed; deployment must remain blocked.')
    print('Schema, migration ledger, foreign keys and integrity verified.')


if __name__ == '__main__':
    main()
