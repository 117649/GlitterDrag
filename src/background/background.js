
window.onerror = function () {
    console.trace(...arguments)
}

window.onrejectionhandled = function () {
    console.trace(...arguments)
}

window.onunhandledrejection = function () {
    console.trace(...arguments)
}

const REDIRECT_URL = browser.runtime.getURL("redirect/redirect.html");

function randomString(length = 8) {
    // https://stackoverflow.com/questions/10726909/random-alpha-numeric-string-in-javascript
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (var i = length; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
    return result;
}

function safeFilename(filename) {
    const pattern = /[<>:"|?*]/;
    if (navigator.platform.startsWith("Win")) {
        return filename.split(pattern).join("_");
    }
    return filename;
}

function createBlobObjectURLForText(text = "") {
    let blob = new window.Blob([text], {
        type: "text/plain"
    });
    return window.URL.createObjectURL(blob);
}

function processURLPlaceholders(url, keyword, args) {
    // 二级域名 (host)
    let secondaryDomain = '';
    // 完整域名
    let domainName = '';
    // 参数部分
    let parameter = '';
    // protocol部分
    let protocol = '';
    try {
        let urlKeyword = new URL(keyword);
        protocol = urlKeyword.protocol;
        parameter = urlKeyword.pathname.substr(1) + urlKeyword.search;
        domainName = urlKeyword.hostname;
        let domainArr = domainName.split('.');
        if (domainArr.length < 2) {
            // 链接不包含二级域名(例如example.org, 其中example为二级域, org为顶级域) 使用domainName替代
            secondaryDomain = domainName;
        } else {
            secondaryDomain = domainArr[domainArr.length - 2] + "." + domainArr[domainArr.length - 1]
        }
    } catch (Error) {
        // 这里的异常用作流程控制: 非链接 -> 不作处理(使用''替换可能存在的误用占位符即可)
    }

    // 大写的占位符表示此字段无需Base64编码(一般是非参数)
    url = url
        .replace("%S", keyword)
        .replace("%X", `site:${args.site} ${keyword}`)
        .replace("%O", protocol)
        .replace("%D", domainName)
        .replace("%H", secondaryDomain)
        .replace("%P", parameter)

    url = url
        .replace("%s", encodeURIComponent(keyword))
        .replace("%x", encodeURIComponent(`site:${args.site} ${keyword}`))
        .replace("%o", encodeURIComponent(protocol))
        .replace("%d", encodeURIComponent(domainName))
        .replace("%h", encodeURIComponent(secondaryDomain))
        .replace("%p", encodeURIComponent(parameter))

    return url;
}

function returnFirstNotNull() {
    return [...arguments].find(a => a !== null && a !== undefined)
}

class ExecutorClass {
    constructor() {
        //template

        this.backgroundChildTabCount = 0;
        this.lastDownloadItemID = -1;
        this.lastDownloadObjectURL = ""; //prepare for revoke
        this.findFlag = false;
        this.bgConfig = null;
        this.sender = null
        this.data = null
        this.temporaryDataStorage = new Map()

        this.downloadIdSetToRevoke = new Map()


        browser.storage.onChanged.addListener((_, areaName) => {
            if (areaName === "local") {
                this.refreshBackgroundConfig()
            }
        })

        browser.downloads.onChanged.addListener(item => {
            if (this.downloadIdSetToRevoke.has(item.id)) {
                if (item.state.current === "interrupted" || item.state.current === "complete") {
                    window.URL.revokeObjectURL(this.lastDownloadObjectURL);
                    this.downloadIdSetToRevoke.delete(item.id)
                }
            }
        })

        browser.tabs.onRemoved.addListener(() => {
            this.backgroundChildTabCount = 0;
        });

        browser.tabs.onActivated.addListener(() => {
            this.backgroundChildTabCount = 0;
        });

        this.refreshBackgroundConfig()

    }

    async refreshBackgroundConfig() {
        console.info("refresh background config")
        browser.storage.local.get().then(a => {
            this.bgConfig = a
        })
    }

    async DO(actionWrapper, sender) {
        console.time("do action")
        this.data = actionWrapper
        this.sender = sender
        await this.execute();
        this.data = null
        this.sender = null
        console.timeEnd("do action")
    }

    async execute() {
        switch (this.data.command) {
            case "open":
                return this.openHandler();
            case "copy":
                return this.copyHandler();
            case "search":
                return this.searchHandler();
            case "download":
                return this.downloadHandler();
            case "find":
                return this.findText(this.data.selection.text);
            case "translate":
                return this.translateText(this.data.selection.text);
            case "runScript":
                return this.runScript()
            case "":
                console.log("no operation")
                return
            default:
                console.error(`unexcepted commond: "${this.data.command}"`)
        }
    }

    async openHandler() {
        console.time("openHandler")
        if (this.data.actionType === "text") {
            await this.searchText(this.data.selection.text);
        }
        else if (this.data.actionType === "link") {
            if (this.data.commandTarget === "image") {
                // TODO
                await this.openURL(this.data.selection.imageLink)
            }
            else if (this.data.commandTarget === "text") {
                //TODO
                await this.openURL(this.data.selection.text);
            }
            else await this.openURL(this.data.selection.plainUrl)
        }
        else if (this.data.actionType === "image") {
            if (this.data.selection.imageLink !== "") {
                await this.openURL(this.data.selection.imageLink)
            } else {
                await this.fetchImagePromise(this.data.extraImageInfo)
                    .then(u8Array => {
                        this.openImageViewer(u8Array)
                    })
            }
        }
        console.timeEnd("openHandler")
    }

    async copyHandler() {
        console.log("copyHandler")
        if (this.data.actionType === "link") {
            switch (this.data.commandTarget) {
                case "image":
                    return this.copyText(
                        returnFirstNotNull(
                            this.data.selection.imageLink,
                            this.data.selection.link
                        ))
                case "text":
                    return this.copyText(
                        returnFirstNotNull(
                            this.data.selection.text,
                            this.data.selection.link
                        ))
                case "link":
                    return this.copyText(this.data.selection.plainUrl)
            }
        } else if (this.data.actionType === "text") {
            return this.copyText(this.data.selection.text)
        } else if (this.data.actionType === "image") {
            switch (this.data.commandTarget) {
                case "image":
                    return this.fetchImagePromise(this.data.extraImageInfo)
                        .then((u8Array) => {
                            this.copyImage(u8Array)
                        })
                case "link":
                    return this.copyText(this.data.selection.imageLink)
            }
        }
    }

    async searchHandler() {
        if (this.data.actionType === "link") {
            if (this.data.commandTarget === "image") {
                return this.searchText(this.data.selection.imageLink);
            }
            else if (this.data.commandTarget === "text") {
                return this.searchText(this.data.selection.text);
            }
            else {
                return this.searchText(this.data.selection.plainUrl);
            }
        }
        else if (this.data.actionType === "image") {
            if (this.data.commandTarget === "image") {
                return this.fetchImagePromise(this.data.extraImageInfo)
                    .then(u8Array => {
                        this.searchImageByPostMethod(u8Array)
                    })
            } else {
                return this.searchImage(this.data.selection.imageLink);
            }
        }
        else if (this.data.commandTarget === "text") {
            return this.searchText(this.data.selection.text);
        }
    }

    async downloadHandler() {
        if (this.data.actionType === "link") {
            if (this.data.commandTarget === "image") {
                return this.download(this.data.selection.imageLink);
            } else if (this.data.commandTarget === "link") {
                return this.download(this.data.selection.plainUrl);
            }
        }
        else if (this.data.actionType === "text") {
            const url = createBlobObjectURLForText(this.data.textSelection);
            return this.download(url, `${Date.now()}.txt`);
        }
        else if (this.data.actionType === "image") {
            if (this.data.selection.imageLink !== null) {
                return this.download(this.data.selection.imageLink)
            } else {
                // TODO 
            }
        }
    }

    async searchText(keyword) {
        console.log("search text: ", keyword)
        if (this.data.searchEngine.url === "" || this.data.searchEngine.builtin === true) {
            const tabHoldingSearch = await this.openTab('about:blank');
            console.log("call browser search api",
                ", engine name:", this.data.searchEngine.name,
                ", tab holds search page:", tabHoldingSearch)
            //TODO: check error
            return browser.search.search({
                query: keyword,
                engine: this.data.searchEngine.name,
                tabId: tabHoldingSearch.id
            });
        }
        else {
            console.log(`search engine name: "${this.data.searchEngine.name}" , url: "${this.data.searchEngine.url}"`)
            return this.openURL(processURLPlaceholders(this.data.searchEngine.url, keyword, {
                site: this.data.site
            }))
        }

    }

    async searchImage(imageUrl) {
        //TODO
        return this.openTab()
    }

    async searchImageByPostMethod(u8Array) {
        //TODO
        const key = randomString(10)
        this.temporaryDataStorage.set(key, {
            cmd: "search",
            data: u8Array
        })
        //TODO: 不允许在 private window 打开 redirect页面，需要检查
        return this.openTab(REDIRECT_URL + "?key=" + key)
    }

    async findText(text) {
        console.log("find text:", text)
        if (text.length == 0) return;
        const result = await browser.find.find(text)
        if (result.count > 0) {
            this.findFlag = true;
            browser.find.highlightResults();
        }
    }

    async removeHighlighting() {
        console.log("remove find")
        if (this.findFlag) {
            this.findFlag = false;
            return browser.find.removeHighlighting();
        }
    }

    async download(url) {
        console.log("download: ", url)
        browser.downloads.download({
            url,
            saveAs: this.data.download.showSaveAsDialog,
            headers: [{ name: "Referer", value: this.data.site }]
        })
    }


    async translateText(text) {
        const sended = {
            command: "translate",
            data: text
        }

        let portName = "sendToContentScript";
        const tabs = await browser.tabs.query({
            currentWindow: true,
            active: true
        });

        let port = browser.tabs.connect(tabs[0].id, { name: portName });
        return port.postMessage(sended);
    }

    async copyText(data) {
        console.log("copy text:", data)
        return navigator.clipboard.writeText(data)
    }

    async copyImage(u8Array) {
        console.log("copy image, length:", u8Array)
        browser.clipboard.setImageData(u8Array,
            this.data.extraImageInfo.extension === ".png" ? "png" : "jpeg");
    }

    //TODO remove this method
    async openURL(url) {
        if (typeof url !== "string") {
            console.error(`url is ${url} rather than string`)
            return
        }
        await this.openTab(url);
        // return this.searchText(url);
    }


    async openTab(url) {
        if (typeof url !== "string") {
            console.error(`url is ${url} rather than string`)
            return
        }
        console.trace("open tab: ", url, ", tabPosition: ", this.data.tabPosition, ", activeTab: ", this.data.activeTab)

        if (["newWindow", "privateWindow"].includes(this.data.tabPosition)) {
            let win
            if ("newWindow" === this.data.tabPosition) {
                console.log("create window")
                win = await browser.windows.create();
            } else {
                console.log("attempt to reuse icongito window")
                win = (await browser.windows.getAll({ windowTypes: ["normal"] })).find(w => w.incognito)
                if (!win) {
                    console.log("create new icongito window")
                    win = await browser.windows.create({ incognito: true });
                }
            }
            const tab = await browser.tabs.create({
                url: url,
                windowId: win.id,
                active: this.data.activeTab
            })
            if (true === this.data.activeTab) {
                browser.windows.update(win.id, { focused: true })
            }
            return tab;
        }
        else {
            console.time("query tabs")
            const tabs = await browser.tabs.query({ currentWindow: true });
            console.timeEnd("query tabs")
            const activatedTab = tabs.find(t => t.active)
            if (!activatedTab) {
                throw new Error("No actived tab is found");
            }
            if (this.data.tabPosition === "overrideCurrent") {
                browser.tabs.update(activatedTab.id, { url });
            }
            else {
                const option = {
                    active: this.data.activeTab,
                    url,
                    openerTabId: activatedTab.id
                };
                if (this.data.tabPosition !== "") {
                    option.index = this.getTabIndex(tabs.length, activatedTab.index)
                }
                // console.time("create tab")
                /*const newTab = */
                return browser.tabs.create(option);
                // console.timeEnd("create tab")
            }
        }
    }

    getTabIndex(tabsLength = 0, currentTabIndex = 0) {
        console.log("calc the index of new created tab",
            ", tabsLength:", tabsLength,
            ", currentTabIndex:", currentTabIndex,
            ", backgroundChildCount:", this.backgroundChildTabCount)
        if (this.data.activeTab) {
            this.backgroundChildTabCount = 0;
        }

        let index = 0;
        switch (this.data.tabPosition) {
            case "left": index = currentTabIndex; break;
            case "right": index = currentTabIndex + this.backgroundChildTabCount + 1; break;
            case "start": index = 0; break;
            case "end": index = tabsLength; break;
            default: break;
        }

        if (!this.data.activeTab && this.data.tabPosition === "right") {
            this.backgroundChildTabCount += 1;
            console.log("increase backgroundChildTabCount: ", this.backgroundChildTabCount)
        }
        console.log("the index of tab maybe: ", index)
        return index;
    }

    async fetchImagePromise(extraImageInfo) {
        console.log("create fetch image promise")
        return new Promise((resolve, reject) => {
            const port = browser.tabs.connect(this.sender.tabId)
            if (port.error) {
                console.trace(port, port.error)
                reject(port.error)
                return
            }
            port.onMessage.addListener(u8Array => {
                console.log('get u8Array, call disconnect then resolve promise')
                port.disconnect()
                resolve(u8Array)
            })
            port.postMessage(extraImageInfo.token)
        })
    }

    async runScript() {
        return browser.tabs.executeScript({
            code: this.data.script
        })
    }

    async openImageViewer(u8Array) {

    }
}

var executor = new ExecutorClass();

//点击工具栏图标时打开选项页
// browser.browserAction.onClicked.addListener(() => {
//     browser.runtime.openOptionsPage();
// });

async function insertCSS(sender) {
    browser.tabs.insertCSS(sender.tab.id, {
        frameId: sender.frameId,
        file: browser.runtime.getURL("content_scripts/content_script.css"),
        runAt: "document_end"
    });
    const storage = await (browser.storage.local.get(["enableStyle", "style"]));
    if (storage["enableStyle"] === true) {
        browser.tabs.insertCSS(sender.tab.id, { frameId: sender.frameId, code: storage.style, runAt: "document_end" });
    }
}

browser.runtime.onMessage.addListener(async (m, sender) => {
    switch (m.msgCmd) {
        case "removeHighlighting":
            executor.removeHighlighting();
            break;
        case "insertCSS":
            insertCSS(sender);
            break;
        case "postAction":
            executor.DO(m, sender);
            break;
    }
});

console.info("Glitter Drag: background script executed.")