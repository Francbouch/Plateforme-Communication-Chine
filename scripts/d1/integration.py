"""Exercise the actual Wrangler runner against an isolated local D1, never remote."""
from pathlib import Path
from tempfile import TemporaryDirectory
from migrate import MIGRATIONS, ROOT, Wrangler, migrate

with TemporaryDirectory(prefix='forgebridge-d1-') as directory:
    runner = Wrangler(False, Path(directory) / 'state')
    files = sorted(MIGRATIONS.glob('*.sql'))
    sql = (ROOT / 'scripts/initialize-empty-d1.sql').read_text()
    sql += '\n' + '\n'.join(f.read_text() for f in files[2:4])
    sql += """
INSERT INTO profiles(id,name) VALUES('sentinel','Preserved');
INSERT INTO organizations(id,name) VALUES('org','Preserved org');
INSERT INTO projects(id,organization_id,code,name) VALUES('project','org','TEST','Preserved project');
INSERT INTO documents(id,project_id,name) VALUES('doc','project','Preserved document');
INSERT INTO document_revisions(id,document_id,ordinal,label,filename,extension,content_type,size,sha256,object_key,created_by)
VALUES('rev','doc',1,'A','test.pdf','pdf','application/pdf',1,printf('%064d',0),'private/object/unchanged','sentinel');
INSERT INTO review_items(id,document_id,revision_id,number,page,type,color,geometry,summary,created_by)
VALUES('drawing','doc','rev',1,1,'marker','red','{}','Legacy technical point','sentinel');
INSERT INTO review_messages(id,item_id,body,author_id) VALUES('message','drawing','Preserved discussion','sentinel');
INSERT INTO review_events(id,item_id,actor_id,action,payload) VALUES('event','drawing','sentinel','reply.created','{}');
"""
    fixture = Path(directory) / 'manual-four.sql'
    fixture.write_text(sql)
    runner.run('execute', 'forgebridge-db', '--local', '--file', str(fixture), *runner.persist_args)
    assert runner.inspect() == ([f.name for f in files[2:4]], [files[4].name])
    migrate(runner, apply=True)
    expected = {
        'SELECT id,name FROM profiles': [{'id': 'sentinel', 'name': 'Preserved'}],
        'SELECT id,object_key FROM document_revisions': [{'id': 'rev', 'object_key': 'private/object/unchanged'}],
        'SELECT id,body FROM review_messages': [{'id': 'message', 'body': 'Preserved discussion'}],
        'SELECT id FROM review_events': [{'id': 'event'}],
        'SELECT id,is_point,title FROM review_items': [{'id': 'drawing', 'is_point': 1, 'title': 'Legacy technical point'}],
        'SELECT id,point_id FROM graphical_annotations': [{'id': 'drawing', 'point_id': 'drawing'}],
    }
    for query, rows in expected.items():
        assert runner.query(query) == rows, query
    before = runner.query('SELECT * FROM d1_migrations ORDER BY id')
    migrate(runner, apply=True)
    assert runner.query('SELECT * FROM d1_migrations ORDER BY id') == before
    for query, rows in expected.items():
        assert runner.query(query) == rows, query
    try:
        runner.query("DELETE FROM document_revisions WHERE id='rev'")
    except Exception as error:
        import subprocess
        assert isinstance(error, subprocess.CalledProcessError), error
        assert 'revisions are immutable' in error.stdout, error.stdout
    else:
        raise AssertionError('Immutable revision protection did not reject deletion')
    print('Integration passed: manual 0004 recognized, only 0005 applied, backfill/data/protections preserved, rerun unchanged.')
