"""在含测试作品的隔离服务上，通过 browser-harness 执行真实按键与滚轮验收。"""
import json, os, time

def evaluate(expression):
    response = cdp('Runtime.evaluate', expression=expression, awaitPromise=True, returnByValue=True)
    if response.get('exceptionDetails'):
        raise AssertionError(response['exceptionDetails'].get('exception', {}).get('description') or response['exceptionDetails']['text'])
    return response['result'].get('value')

def wait_for(expression, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if evaluate(expression): return
        time.sleep(.05)
    raise AssertionError('未满足界面条件：'+expression)

def click(selector):
    evaluate('document.querySelector('+json.dumps(selector)+').scrollIntoView({block:"center"})')
    point=evaluate('(()=>{const r=document.querySelector('+json.dumps(selector)+').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()')
    click_at_xy(point['x'],point['y'])
    time.sleep(.15)

def key(value, code, modifiers=0, virtual=0):
    cdp('Input.dispatchKeyEvent',type='keyDown',key=value,code=code,modifiers=modifiers,windowsVirtualKeyCode=virtual)
    cdp('Input.dispatchKeyEvent',type='keyUp',key=value,code=code,modifiers=modifiers,windowsVirtualKeyCode=virtual)
    time.sleep(.15)

new_tab(os.environ.get('NOVEL_KING_AUDIT_URL','http://localhost:38470/'))
cdp('Emulation.setDeviceMetricsOverride',width=1440,height=900,deviceScaleFactor=1,mobile=False)
wait_for('!!document.querySelector(".book-cover")')
click('.book-cover')
wait_for('!!document.querySelector("[data-action=writing-canvas]")')
click('[data-action="writing-canvas"]')
wait_for('document.querySelectorAll(".excalidraw canvas").length===2')
assert evaluate('!!document.querySelector(".canvas-shortcut-button")'), '应有独立快捷键设置按钮'
click('.canvas-shortcut-button')
wait_for('!!document.querySelector(".shortcut-dialog")')
click('.shortcut-reset')
assert evaluate('document.querySelectorAll("[data-shortcut-action=freedraw] .shortcut-binding").length')==2

def slot(action, index=0): return '[data-shortcut-action="'+action+'"] .shortcut-binding[data-slot="'+str(index)+'"]'
click(slot('freedraw'))
key('q','KeyQ',virtual=81)
click(slot('freedraw',1))
key('F6','F6',virtual=117)
click('.shortcut-apply')
wait_for('!document.querySelector(".shortcut-dialog")')
# The native canvas must receive both bindings; the old P binding must stop firing.
click('.excalidraw canvas')
key('q','KeyQ',virtual=81)
assert evaluate('document.querySelector("[data-testid=toolbar-freedraw]").checked'), 'Q 应切换到铅笔'
key('v','KeyV',virtual=86)
key('F6','F6',virtual=117)
assert evaluate('document.querySelector("[data-testid=toolbar-freedraw]").checked'), '备用 F6 应生效'
key('v','KeyV',virtual=86)
key('p','KeyP',virtual=80)
assert evaluate('document.querySelector("[data-testid=toolbar-selection]").checked'), '改绑后旧 P 不应继续触发'

# A collision requires an explicit replacement. Cancelling leaves saved bindings intact.
click('.canvas-shortcut-button')
click(slot('freedraw'))
key('t','KeyT',virtual=84)
wait_for('!!document.querySelector(".shortcut-replace")')
click('.shortcut-cancel')
click('.canvas-shortcut-button')
assert evaluate('document.querySelector('+json.dumps(slot('freedraw'))+').textContent')=='Q'
click(slot('zoomIn',1))
point=evaluate('(()=>{const r=document.querySelector(".shortcut-dialog").getBoundingClientRect();return{x:r.x+40,y:r.y+80}})()')
cdp('Input.dispatchMouseEvent',type='mouseWheel',x=point['x'],y=point['y'],deltaX=0,deltaY=-100)
wait_for('!!document.querySelector(".shortcut-replace")')
click('.shortcut-replace')
click('.shortcut-apply')
wait_for('!document.querySelector(".shortcut-dialog")')
assert evaluate('JSON.parse(localStorage.novel_king_canvas_shortcuts).zoomIn[1]')=='Mouse+'
assert evaluate('JSON.parse(localStorage.novel_king_canvas_shortcuts).panUp[0]')==''
evaluate('document.querySelector(".excalidraw-container").focus()')
zoom_before=evaluate('writingCanvas.snapshot().appState.zoom.value')
key('+','Equal',modifiers=8,virtual=187)
assert evaluate('writingCanvas.snapshot().appState.zoom.value')==zoom_before, '旧 Shift+= 缩放别名也应停用'
point=evaluate('(()=>{const r=document.querySelector(".excalidraw canvas").getBoundingClientRect();return{x:r.x+r.width*.6,y:r.y+r.height*.6}})()')
zoom_before=evaluate('document.querySelector(".zoom-actions").textContent')
cdp('Input.dispatchMouseEvent',type='mouseWheel',x=point['x'],y=point['y'],deltaX=0,deltaY=-100)
time.sleep(.3)
assert evaluate('document.querySelector(".zoom-actions").textContent')!=zoom_before, 'Mouse+ 应执行放大'
print('PASS 独立入口、双槽录入、工具实际执行、旧键停用、冲突取消与滚轮改绑')

# Runtime commands operate on Excalidraw's real selection/history, not a parallel scene.
click('.canvas-shortcut-button')
for action, name, code, virtual in [('delete','F7','F7',118), ('undo','F8','F8',119), ('redo','F9','F9',120), ('save','F10','F10',121)]:
    click(slot(action))
    key(name,code,virtual=virtual)
click('.shortcut-apply')
click('.excalidraw canvas')
count_before=evaluate('writingCanvas.snapshot().elements.filter(e=>!e.isDeleted).length')
key('Enter','Enter',modifiers=2,virtual=13)
wait_for('writingCanvas.snapshot().elements.filter(e=>!e.isDeleted).length>'+str(count_before))
count_added=evaluate('writingCanvas.snapshot().elements.filter(e=>!e.isDeleted).length')
key('F7','F7',virtual=118)
wait_for('writingCanvas.snapshot().elements.filter(e=>!e.isDeleted).length==='+str(count_before))
key('F8','F8',virtual=119)
wait_for('writingCanvas.snapshot().elements.filter(e=>!e.isDeleted).length==='+str(count_added))
key('F9','F9',virtual=120)
wait_for('writingCanvas.snapshot().elements.filter(e=>!e.isDeleted).length==='+str(count_before))
key('F10','F10',virtual=121)
wait_for('document.querySelector(".canvas-status").classList.contains("saved")')
print('PASS 自定义删除、撤销、重做、保存作用于真实画布')

# Unmodified down-wheel pans down; horizontal input is not mistaken for zoom.
scroll_before=evaluate('writingCanvas.snapshot().appState.scrollY')
cdp('Input.dispatchMouseEvent',type='mouseWheel',x=point['x'],y=point['y'],deltaX=0,deltaY=100)
time.sleep(.25)
assert evaluate('writingCanvas.snapshot().appState.scrollY')<scroll_before
horizontal_before=evaluate('writingCanvas.snapshot().appState.scrollX')
zoom_before=evaluate('writingCanvas.snapshot().appState.zoom.value')
cdp('Input.dispatchMouseEvent',type='mouseWheel',x=point['x'],y=point['y'],deltaX=-100,deltaY=0)
time.sleep(.25)
assert evaluate('writingCanvas.snapshot().appState.scrollX')>horizontal_before
assert evaluate('writingCanvas.snapshot().appState.zoom.value')==zoom_before

# Native text editing must keep plain letters and shortcuts inside the text editor.
click('.canvas-commandbar > .canvas-primary')
# Toolbar clicks retain button focus; focus the canvas before the native Enter shortcut.
evaluate('document.querySelector(".excalidraw-container").focus()')
key('Enter','Enter',virtual=13)
wait_for('!!document.querySelector("textarea.excalidraw-wysiwyg")')
key('q','KeyQ',virtual=81)
cdp('Input.insertText',text='剧情测试')
assert evaluate('document.querySelector("textarea.excalidraw-wysiwyg").value.includes("剧情测试")')
key('F7','F7',virtual=118)
assert evaluate('!!document.querySelector("textarea.excalidraw-wysiwyg")')
key('Escape','Escape',virtual=27)
wait_for('!document.querySelector("textarea.excalidraw-wysiwyg")')
print('PASS 上下与水平滚轮方向、文字编辑保护')

# Capture a real modifier combination and a real downward wheel, not hand-written settings.
click('.canvas-shortcut-button')
click(slot('rectangle',1))
key('J','KeyJ',modifiers=10,virtual=74)
assert evaluate('document.querySelector('+json.dumps(slot('rectangle',1))+').textContent')=='Ctrl+Shift+J'
click(slot('panDown',1))
point=evaluate('(()=>{const r=document.querySelector(".shortcut-dialog").getBoundingClientRect();return{x:r.x+40,y:r.y+80}})()')
cdp('Input.dispatchMouseEvent',type='mouseWheel',x=point['x'],y=point['y'],deltaX=0,deltaY=100)
wait_for('!!document.querySelector(".shortcut-replace")')
assert evaluate('document.querySelector(".shortcut-feedback").textContent.includes("向下平移")')
click('.shortcut-replace')
click('.shortcut-apply')
assert evaluate('JSON.parse(localStorage.novel_king_canvas_shortcuts).panDown[1]')=='Mouse-'
assert evaluate('JSON.parse(localStorage.novel_king_canvas_shortcuts).panDown[0]')==''
evaluate('document.querySelector(".excalidraw-container").focus()')
key('J','KeyJ',modifiers=10,virtual=74)
assert evaluate('document.querySelector("[data-testid=toolbar-rectangle]").checked')
key('v','KeyV',virtual=86)
key('2','Numpad2',virtual=98)
assert evaluate('document.querySelector("[data-testid=toolbar-selection]").checked'), '小键盘数字不能偷用已清除的数字别名'
click('.canvas-commandbar > .canvas-primary')
click('.canvas-ai-panel' if evaluate('!!document.querySelector(".canvas-ai-panel")') else '.canvas-commandbar > button:last-child')
wait_for('!!document.querySelector(".canvas-ai-panel textarea")')
click('textarea[aria-label="画布 AI 要求"]')
count_before=evaluate('writingCanvas.snapshot().elements.filter(e=>!e.isDeleted).length')
cdp('Input.insertText',text='检查输入区的快捷键保护')
key('F7','F7',virtual=118)
assert evaluate('writingCanvas.snapshot().elements.filter(e=>!e.isDeleted).length')==count_before
key('J','KeyJ',modifiers=10,virtual=74)
assert evaluate('document.querySelector("[data-testid=toolbar-selection]").checked')
click('[aria-label="关闭画布 AI"]')
print('PASS 真实组合键、下滚录入和 AI 输入区保护')

# Cleared slots stay empty after reloading, and restore-defaults remains cancellable.
click('.canvas-shortcut-button')
click('[data-shortcut-action=freedraw] .shortcut-clear[data-slot="0"]')
click('.shortcut-apply')
evaluate('writingCanvas.flush()')
cdp('Page.reload')
wait_for('!!document.querySelector(".book-cover") || !!document.querySelector("[data-action=writing-canvas]")')
if evaluate('!!document.querySelector(".book-cover")'): click('.book-cover')
wait_for('!!document.querySelector("[data-action=writing-canvas]")')
click('[data-action="writing-canvas"]')
wait_for('document.querySelectorAll(".excalidraw canvas").length===2')
click('.canvas-shortcut-button')
assert evaluate('document.querySelector('+json.dumps(slot('freedraw'))+').textContent')=='点击绑定'
assert evaluate('document.querySelector('+json.dumps(slot('freedraw',1))+').textContent')=='F6'
click(slot('text'))
key('Escape','Escape',virtual=27)
assert evaluate('!!document.querySelector(".shortcut-dialog")'), 'Esc 先取消录入'
click('.shortcut-reset')
click('.shortcut-cancel')
assert evaluate('JSON.parse(localStorage.novel_king_canvas_shortcuts).freedraw[0]')==''
click('.canvas-shortcut-button')
click('.shortcut-reset')
click('.shortcut-apply')
assert evaluate('JSON.parse(localStorage.novel_king_canvas_shortcuts).freedraw[0]')=='P'
print('PASS 清空持久化、Esc 取消录入、默认配置取消与应用')

artifact_dir=os.path.join(os.environ['TEMP'],'novel-king-shortcut-review')
os.makedirs(artifact_dir,exist_ok=True)
click('.canvas-shortcut-button')
capture_screenshot(os.path.join(artifact_dir,'shortcuts-desktop.png'))
cdp('Emulation.setDeviceMetricsOverride',width=390,height=844,deviceScaleFactor=1,mobile=True)
time.sleep(.4)
assert evaluate('document.querySelector(".shortcut-dialog").getBoundingClientRect().right<=390')
assert evaluate('document.querySelector(".shortcut-dialog").scrollWidth<=document.querySelector(".shortcut-dialog").clientWidth')
capture_screenshot(os.path.join(artifact_dir,'shortcuts-mobile.png'))
print('PASS 桌面与手机窗口无横向溢出')
