import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../js/server.js', import.meta.url), 'utf8');
function setup({online = true, failUpload = false, missingFile = false, switchProject = false} = {}) {
  const calls = [], errors = [], modals = [], copies = [];
  const node = {name: 'source.mp4', path: 'folder/source.mp4'};
  const D = {
    state: {project: {id: 'demo'}, ai: {drops: {'apply.target': [node]}}},
    flatten: x => x, fileOf: () => missingFile ? null : new Blob(['media']),
    Projects: {save: async () => { calls.push('save'); }},
    el: () => ({appendChild() {}}), modal: {open: x => modals.push(x)},
    copy: x => copies.push(x), info() {}, warn() {}, toast() {}, error: x => errors.push(x)
  };
  const fetch = async (url, options) => {
    calls.push(url);
    if (url.startsWith('/api/media/upload')) {
      if (switchProject) D.state.project.id = 'other';
      return {ok: !failUpload, status: failUpload ? 500 : 200, json: async () => ({ok: true, path: '/projects/demo/media/source.mp4'})};
    }
    const body = JSON.parse(options.body);
    assert.equal(body.job.project, 'demo');
    assert.equal(body.job.mediaPaths[0].path, '/projects/demo/media/source.mp4');
    return {ok: true, json: async () => ({job: '/jobs/demo.json', request: 'Codex request'})};
  };
  vm.runInNewContext(code, {window: {D}, fetch, Blob});
  D.Server.online = online;
  return {D, calls, errors, modals, copies};
}

test('saves project and uploads browser media before creating a Codex request', async () => {
  const x = setup();
  await x.D.Server.submit('스타일 적용', 'preview only', {task: 'style.apply'});
  assert.equal(x.errors.length, 0);
  assert.equal(x.calls[0], 'save');
  assert.match(x.calls[1], /^\/api\/media\/upload\?project=demo/);
  assert.deepEqual(x.calls.slice(2), ['save', '/api/job']);
  assert.equal(x.modals.length, 1);
  x.modals[0].buttons[0].onClick();
  assert.deepEqual(x.copies, ['Codex request']);
  assert.equal(x.D.Server.submitting, false);
});

for (const option of ['failUpload', 'missingFile', 'switchProject']) {
  test(option + ' stops handoff instead of creating an unusable job', async () => {
    const x = setup({[option]: true});
    await x.D.Server.submit('스타일 적용', 'prompt', {task: 'style.apply'});
    assert.equal(x.errors.length, 1);
    assert.equal(x.calls.includes('/api/job'), false);
    assert.equal(x.modals.length, 0);
    assert.equal(x.D.Server.submitting, false);
  });
}

test('offline handoff includes job JSON and asks for source media', async () => {
  const x = setup({online: false});
  await x.D.Server.submit('스타일 적용', 'prompt', {task: 'style.apply'});
  assert.equal(x.calls.length, 0);
  x.modals[0].buttons[0].onClick();
  assert.match(x.copies[0], /style.apply/);
  assert.match(x.copies[0], /영상은 별도로/);
});
