'use strict'

const path = require('path')

const { app, BrowserWindow, ipcMain } = require('electron')

const robots = require('./robots.js')

const workflows = require('./workflows.js')
const knownPublishers = Object.keys(workflows)

const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())

const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker')
puppeteer.use(AdblockerPlugin({ blockTrackers: true }))

function createWindow () {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  })

  win.loadFile('index.html', { query: { knownPublishers } })
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.on('get-editors', async (event, publisher) => {
  try {
    // TODO: Add {headless: false} as an option for debugging.
    const browser = await puppeteer.launch({
      headless: true,
      defaultViewport: { width: 1200, height: 900 },
      executablePath: puppeteer.executablePath().replace('app.asar', 'app.asar.unpacked')
    })
    const page = await browser.newPage()

    // Wrap page.goto to add robots.txt support.
    const originalGoto = page.goto.bind(page)
    page.goto = async function (url) {
      if (await robots.canCrawl(url)) {
        // Use crawl delay requested by publisher.
        const crawlDelay = await robots.getCrawlDelay(url)
        await page.waitForTimeout(crawlDelay * 1000)
        return originalGoto(url)
      }
      throw new Error('Blocked by robots.txt')
    }

    const workflow = workflows[publisher]
    await page.goto(workflow.start)
    await workflow.getData(page, event)
    await browser.close()
  } catch (err) {
    event.reply('print', 'There was an unexpected error:\n')
    event.reply('print', `${err.stack}\n`)
  }
  event.reply('done')
})

/*
TimeoutError: Navigation timeout of 30000 ms exceeded
    at /Users/trott/ucsf-ckm/editor-scraper/node_modules/puppeteer/lib/cjs/puppeteer/common/LifecycleWatcher.js:106:111
    at async FrameManager.waitForFrameNavigation (/Users/trott/ucsf-ckm/editor-scraper/node_modules/puppeteer/lib/cjs/puppeteer/common/FrameManager.js:128:23)
    at async Frame.waitForNavigation (/Users/trott/ucsf-ckm/editor-scraper/node_modules/puppeteer/lib/cjs/puppeteer/common/FrameManager.js:441:16)
    at async Page.waitForNavigation (/Users/trott/ucsf-ckm/editor-scraper/node_modules/puppeteer/lib/cjs/puppeteer/common/Page.js:1218:16)
    at async Object.getData (/Users/trott/ucsf-ckm/editor-scraper/workflows.js:294:13)
    at async IpcMainImpl.<anonymous> (/Users/trott/ucsf-ckm/editor-scraper/main.js:53:7)
*/
