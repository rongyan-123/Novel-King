"""通过 browser-harness 运行；仅指向已启动的隔离验收服务。"""
import json, os, time

def evaluate(expression):
    response = cdp('Runtime.evaluate', expression=expression, awaitPromise=True, returnByValue=True)
    if response.get('exceptionDetails'):
        raise AssertionError(response['exceptionDetails']['text'])
    return response['result'].get('value')

def click(selector):
    evaluate('document.querySelector('+json.dumps(selector)+').scrollIntoView({block:"center"})')
    point=evaluate('(()=>{const r=document.querySelector('+json.dumps(selector)+').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()')
    click_at_xy(point['x'], point['y'])
    time.sleep(.2)

new_tab(os.environ.get('NOVEL_KING_AUDIT_URL', 'http://localhost:38470/'))
cdp('Emulation.setDeviceMetricsOverride', width=1440, height=900, deviceScaleFactor=1, mobile=False)
cdp('Runtime.enable')
time.sleep(1)
click('.book-cover')
time.sleep(.5)
click('[data-action="writing-canvas"]')
time.sleep(.8)
assert evaluate('document.querySelectorAll(".excalidraw canvas").length') == 2
before=evaluate('writingCanvas.snapshot().elements.filter(e=>!e.isDeleted).length')
for iteration in range(3):
    click('.excalidraw .main-menu-trigger')
    assert evaluate('document.querySelectorAll(".excalidraw canvas").length') == 2, '打开菜单后画布被卸载'
    click_at_xy(1100,550)
    time.sleep(.2)
grid_before=evaluate('writingCanvas.snapshot().appState.gridModeEnabled')
click('.excalidraw .main-menu-trigger')
click('[data-testid="novel-canvas-grid"]')
assert evaluate('writingCanvas.snapshot().appState.gridModeEnabled') != grid_before, '菜单网格应正常切换'
click_at_xy(1100,550)
click('.canvas-commandbar > .canvas-primary')
assert evaluate('writingCanvas.snapshot().elements.filter(e=>!e.isDeleted).length') > before, '关闭菜单后应继续添加剧情卡'
evaluate('writingCanvas.flush()')
print('PASS 画布菜单反复开关后仍可继续绘图')

# 外观切换必须保留正文节点与已挂载画布，不得通过刷新实现。
assert evaluate('document.querySelector("#editor-content")!==null'), '应取得真实正文节点'
evaluate('window.auditEditor=document.querySelector("#editor-content");window.auditCanvas=writingCanvas;window.auditElements=JSON.stringify(writingCanvas.snapshot().elements)')
click('.workspace-titlebar [data-action="open-global-appearance"]')
click('.global-appearance input[name="style"][value="cartoon"]')
click('.global-appearance input[name="mode"][value="dark"]')
click('[data-action="save-global-appearance"]')
assert evaluate('document.documentElement.dataset.uiStyle') == 'cartoon'
assert evaluate('document.documentElement.dataset.theme') == 'dark'
assert evaluate('window.auditCanvas===writingCanvas && window.auditElements===JSON.stringify(writingCanvas.snapshot().elements)'), '外观切换不应重建或改写画布'
assert evaluate('window.auditEditor===document.querySelector("#editor-content")'), '外观切换不应重建正文'
assert evaluate('document.querySelectorAll(".excalidraw canvas").length') == 2
click('.excalidraw .main-menu-trigger')
click_at_xy(1100,550)
print('PASS 外观切换保留画布与正文')

artifact_dir = os.path.join(os.environ['TEMP'], 'novel-king-theme-menu-review')
os.makedirs(artifact_dir, exist_ok=True)
for style in ['minimal','cool','premium','cartoon']:
    for mode in ['light','dark']:
        click('.workspace-titlebar [data-action="open-global-appearance"]')
        click('.global-appearance input[name="style"][value="'+style+'"]')
        click('.global-appearance input[name="mode"][value="'+mode+'"]')
        click('[data-action="save-global-appearance"]')
        assert evaluate('document.documentElement.dataset.uiStyle') == style
        assert evaluate('document.documentElement.dataset.theme') == mode
        assert evaluate('window.auditCanvas===writingCanvas && window.auditElements===JSON.stringify(writingCanvas.snapshot().elements)')
        assert evaluate('window.auditEditor===document.querySelector("#editor-content")')
        capture_screenshot(os.path.join(artifact_dir, 'canvas-'+style+'-'+mode+'.png'))
print('PASS 四款风格 × 深浅模式均保留画布与正文')
click('.workspace-titlebar [data-action="open-global-appearance"]')
click('.global-appearance input[name="mode"][value="system"]')
click('[data-action="save-global-appearance"]')
for mode in ['dark','light']:
    cdp('Emulation.setEmulatedMedia',features=[{'name':'prefers-color-scheme','value':mode}])
    time.sleep(.3)
    assert evaluate('document.documentElement.dataset.theme') == mode
    assert evaluate('document.querySelector(".excalidraw").classList.contains("theme--dark")') == (mode=='dark')
    assert evaluate('NovelKingAppearance.read(localStorage).mode') == 'system'
    assert evaluate('window.auditCanvas===writingCanvas && window.auditElements===JSON.stringify(writingCanvas.snapshot().elements)')
click('.workspace-titlebar [data-action="open-global-appearance"]')
click('.global-appearance input[name="mode"][value="dark"]')
evaluate('(()=>{let input=document.querySelector(".global-appearance input[name=accent]");input.value="#416f91";input.dispatchEvent(new Event("input",{bubbles:true}))})()')
click('[data-action="save-global-appearance"]')
assert evaluate('document.documentElement.style.getPropertyValue("--primary")') == '#416f91'
assert evaluate('NovelKingAppearance.read(localStorage).accent') == '#416f91'
click('.workspace-titlebar [data-action="open-global-appearance"]')
click('.global-appearance input[name="style"][value="minimal"]')
click('.modal-foot [data-close-modal]')
assert evaluate('document.documentElement.dataset.uiStyle') == 'cartoon'
print('PASS 跟随系统实时切换、自定义强调色、取消保留原外观')

click('.workspace-titlebar [data-action="writing-prose"]')
click('[data-action="writing-background"]')
assert evaluate('document.querySelector(".appearance-themes")===null && document.querySelector(".writing-appearance input[type=color]")===null')
capture_screenshot(os.path.join(artifact_dir,'background-empty.png'))
# 使用 CDP 的文件选择与原生拖入，不以调用上传处理函数代替交互。
fixture=os.path.join(artifact_dir,'background-fixture.png')
import base64
with open(fixture,'wb') as file:
    file.write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlR8AAAAASUVORK5CYII='))
previous=evaluate('state.writingPreferences.image')
node=cdp('DOM.getDocument')['root']['nodeId']
file_node=cdp('DOM.querySelector',nodeId=node,selector='#writing-background-file')['nodeId']
cdp('DOM.setFileInputFiles',nodeId=file_node,files=[fixture])
time.sleep(.3)
assert evaluate('document.querySelector(".writing-appearance").dataset.pendingImage.startsWith("data:image/png;base64,")')
click('.modal-foot [data-close-modal]')
assert evaluate('state.writingPreferences.image') == previous, '取消上传应保留原背景'
click('[data-action="writing-background"]')
point=evaluate('(()=>{let r=document.querySelector("#background-dropzone").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()')
data={'items':[],'files':[fixture],'dragOperationsMask':1}
cdp('Input.dispatchDragEvent',type='dragEnter',x=point['x'],y=point['y'],data=data)
cdp('Input.dispatchDragEvent',type='drop',x=point['x'],y=point['y'],data=data)
time.sleep(.3)
assert evaluate('document.querySelector(".writing-appearance").dataset.pendingImage.startsWith("data:image/png;base64,")'), '拖入图片应显示预览'
click('[data-action="save-writing-appearance"]')
assert evaluate('state.writingPreferences.image.startsWith("data:image/png;base64,")')
assert evaluate('document.documentElement.dataset.uiStyle') == 'cartoon'
assert evaluate('document.documentElement.dataset.theme') == 'dark'
assert evaluate('window.auditEditor===document.querySelector("#editor-content")')
# 非图片拖入后保留已有图片，并给出可见错误。
click('[data-action="writing-background"]')
invalid=os.path.join(artifact_dir,'invalid.txt')
with open(invalid,'w',encoding='utf-8') as file: file.write('不是图片')
node=cdp('DOM.getDocument')['root']['nodeId']
file_node=cdp('DOM.querySelector',nodeId=node,selector='#writing-background-file')['nodeId']
cdp('DOM.setFileInputFiles',nodeId=file_node,files=[invalid])
time.sleep(.3)
assert evaluate('!document.querySelector("#background-file-error").hidden')
assert evaluate('document.querySelector(".writing-appearance").dataset.pendingImage===state.writingPreferences.image')
click('.modal-foot [data-close-modal]')
print('PASS 图片选择、拖入、取消、应用、非法文件保护')
click('[data-action="writing-font"]')
capture_screenshot(os.path.join(artifact_dir,'font-desktop.png'))
click('.modal-foot [data-close-modal]')
# 选择一款浅色外观留作截图；再刷新验证持久化。
click('.workspace-titlebar [data-action="open-global-appearance"]')
click('.global-appearance input[name="style"][value="premium"]')
click('.global-appearance input[name="mode"][value="light"]')
capture_screenshot(os.path.join(artifact_dir,'appearance-desktop.png'))
click('[data-action="save-global-appearance"]')
assert evaluate('NovelKingAppearance.read(localStorage).style') == 'premium'
cdp('Page.reload')
time.sleep(1.5)
assert evaluate('document.documentElement.dataset.uiStyle') == 'premium'
assert evaluate('document.documentElement.dataset.theme') == 'light'
# 书架入口与手机面板，按可见控件实际操作。
if evaluate('!!document.querySelector(".workspace-brand")'): click('.workspace-brand')
time.sleep(.3)
capture_screenshot(os.path.join(artifact_dir,'bookshelf-desktop.png'))
cdp('Emulation.setDeviceMetricsOverride',width=390,height=844,deviceScaleFactor=1,mobile=True)
time.sleep(.4)
click('.topbar [data-action="open-global-appearance"]')
assert evaluate('document.querySelector(".modal").getBoundingClientRect().right<=390')
assert evaluate('document.documentElement.scrollWidth<=390')
capture_screenshot(os.path.join(artifact_dir,'appearance-mobile.png'))
click('.modal-foot [data-close-modal]')
click('.book-cover')
time.sleep(.3)
click('[data-action="writing-background"]')
assert evaluate('document.querySelector(".modal").getBoundingClientRect().right<=390')
capture_screenshot(os.path.join(artifact_dir,'background-mobile.png'))
click('.modal-foot [data-close-modal]')
capture_screenshot(os.path.join(artifact_dir,'writing-mobile.png'))
print('PASS 刷新保留外观，手机面板没有横向溢出')
