"""Run through browser-harness against the isolated review server on port 38470.

Public seams: HTTP fixture creation and native browser clicks/typing/file chooser.
Uses the dedicated BU_NAME=novel-files-9237 and BU_CDP_URL=http://127.0.0.1:9237.
Never run against the author's preview server or data directory.
"""
import json
import os
import pathlib
import time
import urllib.parse
import urllib.request

origin = 'http://127.0.0.1:38470'
review = pathlib.Path(os.environ['TEMP']) / 'novel-king-file-workspace-review'
review.mkdir(exist_ok=True)


def api(route, body=None, method=None):
    request = urllib.request.Request(origin + '/api' + route,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Content-Type': 'application/json'}, method=method)
    return json.load(urllib.request.urlopen(request))


def upload(name, text, owner):
    query = urllib.parse.urlencode({'name': name, 'area': 'world', 'work_id': owner})
    request = urllib.request.Request(origin + '/api/files/upload?' + query, data=text.encode(), method='POST')
    return json.load(urllib.request.urlopen(request))


def wait_for(expression):
    for attempt in range(60):
        if js(expression):
            return
        time.sleep(.1)
    raise AssertionError('Timed out: ' + expression)


def click(selector, delay=.2):
    point = js('(()=>{const e=document.querySelector(' + json.dumps(selector) + ');'
        'e.scrollIntoView({block:"nearest"});const r=e.getBoundingClientRect();'
        'return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
    click_at_xy(point['x'], point['y'])
    time.sleep(delay)


def select_all():
    for kind in ['keyDown', 'keyUp']:
        cdp('Input.dispatchKeyEvent', type=kind, key='a', code='KeyA', modifiers=2, windowsVirtualKeyCode=65)


def file_button(file):
    return '[data-fl-action=read][data-id="' + file['id'] + '"]'


first = api('/works', {'title': '镜城工作台验收', 'initial_chapter': True})
second = api('/works', {'title': '星海工作台验收'})
rule = upload('世界法则.txt', '镜城的镜子可以保存记忆。', first['id'])
power = upload('能力体系.md', '主角可以读取镜面。', first['id'])
other = upload('世界法则.txt', '另一小说的专属星海设定。', second['id'])
context_id = cdp('Target.createBrowserContext')['browserContextId']
target_id = cdp('Target.createTarget', url='about:blank', browserContextId=context_id)['targetId']
switch_tab(target_id)
cdp('Emulation.setDeviceMetricsOverride', width=1440, height=900, deviceScaleFactor=1, mobile=False)
goto_url(origin)
wait_for('!!document.querySelector("[data-view=library]")')
click('[data-view=library]')
wait_for('!!document.querySelector("[data-fl-action=scope-card]")')
click('[data-fl-action=scope-card][data-id="' + str(first['id']) + '"]')
click('[data-fl-action=area][data-id=world]')
wait_for('!!document.querySelector("[data-fl-editor]")')
assert js('document.querySelectorAll(".fl-document-card").length') == 2
assert '星海设定' not in js('document.querySelector(".fl-library").innerText')
click(file_button(rule))
click('[data-fl-editor]')
select_all()
cdp('Input.insertText', text='镜城的新设定：梦境可以共享。')
click(file_button(power))
assert api('/files/' + rule['id'] + '/edit?work_id=' + str(first['id']))['text'] == '镜城的新设定：梦境可以共享。'
click(file_button(rule))
click('[data-fl-editor]')
select_all()
click('[data-fl-action=format][data-format=B]')
assert js('!!document.querySelector("[data-fl-editor] b")')
click('[data-fl-action=save]')
cdp('Page.reload')
time.sleep(.6)
click('[data-view=library]')
wait_for('!!document.querySelector("[data-fl-editor] b")')
capture_screenshot(str(review / 'desktop.png'))
print('PASS: novel separation, default content, left switch, save before switch, formatting and reload')

click('[data-fl-action=home]')
click('[data-fl-action=area][data-id=outline]')
assert js('!!document.querySelector(".fl-upload-empty")')
assert not js('!!document.querySelector("[data-fl-editor]")')
upload_path = review / '卷纲.txt'
upload_path.write_text('第一卷：寻找失落的镜子。', encoding='utf-8')
document_node = cdp('DOM.getDocument')['root']['nodeId']
picker = cdp('DOM.querySelector', nodeId=document_node, selector='[data-fl-picker]')['nodeId']
cdp('DOM.setFileInputFiles', nodeId=picker, files=[str(upload_path)])
wait_for('!!document.querySelector("[data-fl-editor]")')
assert '寻找失落的镜子' in js('document.querySelector("[data-fl-editor]").innerText')
print('PASS: empty upload surface and native upload opens its content')

click('[data-fl-action=home]')
click('[data-fl-action=area][data-id=world]')
click(file_button(rule))
cdp('Network.enable')
cdp('Network.emulateNetworkConditions', offline=True, latency=0, downloadThroughput=-1, uploadThroughput=-1)
click('[data-fl-editor]')
cdp('Input.insertText', text='【离线草稿】')
click(file_button(power))
assert js('document.querySelector(".fl-document-card[aria-current=true]").dataset.id') == rule['id']
assert '离线草稿' in js('document.querySelector("[data-fl-editor]").innerText')
click('[data-view=works]')
assert js('!!document.querySelector("[data-fl-editor]")')
cdp('Network.emulateNetworkConditions', offline=False, latency=0, downloadThroughput=-1, uploadThroughput=-1)
cdp('Page.reload')
time.sleep(.2)
try:
    cdp('Page.handleJavaScriptDialog', accept=True)
except Exception:
    pass  # Headless Chrome can reload without displaying beforeunload.
time.sleep(.6)
click('[data-view=library]')
wait_for('!!document.querySelector("[data-fl-editor]")')
assert '离线草稿' in js('document.querySelector("[data-fl-editor]").innerText')
click('[data-fl-action=save]')
saved = api('/files/' + rule['id'] + '/edit?work_id=' + str(first['id']))
assert '离线草稿' in saved['text']
print('PASS: offline failure retains current file, blocks leaving, restores local draft and retries online')

api('/files/' + rule['id'] + '/content?work_id=' + str(first['id']),
    {'html': '<p>其他窗口的新版本</p>', 'text': '其他窗口的新版本', 'revision': saved['revision']}, 'PUT')
click('[data-fl-editor]')
cdp('Input.insertText', text='【当前窗口草稿】')
click('[data-fl-action=save]')
wait_for('document.querySelector("[data-fl-save-status]").innerText.includes("其他窗口更新")')
assert '其他窗口更新' in js('document.querySelector("[data-fl-save-status]").innerText')
click(file_button(power))
assert '当前窗口草稿' in js('document.querySelector("[data-fl-editor]").innerText')
assert api('/files/' + rule['id'] + '/edit?work_id=' + str(first['id']))['text'] == '其他窗口的新版本'
capture_screenshot(str(review / 'desktop-conflict.png'))
print('PASS: stale revision preserves both server and local drafts')

cdp('Emulation.setDeviceMetricsOverride', width=390, height=844, deviceScaleFactor=1, mobile=True)
time.sleep(.2)
# Close the app's mobile navigation overlay through a native backdrop click.
if not js('document.querySelector("#sidebar").classList.contains("collapsed")'):
    click_at_xy(370, 240)
time.sleep(.2)
assert js('document.documentElement.scrollWidth <= innerWidth')
assert js('document.body.scrollWidth <= innerWidth')
assert js('!!document.querySelector("[data-fl-editor]")')
capture_screenshot(str(review / 'mobile-editor.png'))
print('PASS: mobile editing, horizontal file switching and no page width overflow')
