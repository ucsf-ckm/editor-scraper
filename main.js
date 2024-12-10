'use strict'

const path = require('path')
const { setTimeout } = require('node:timers/promises')

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
      headless: false,
      defaultViewport: { width: 1400, height: 1200 },
      executablePath: require('puppeteer').executablePath().replace('app.asar', 'app.asar.unpacked')
    })
    const page = await browser.newPage()

    // Wrap page.goto to add robots.txt support.
    const originalGoto = page.goto.bind(page)
    page.goto = async function (url) {
      if (await robots.canCrawl(url)) {
        // Use crawl delay requested by publisher.
        const crawlDelay = await robots.getCrawlDelay(url)
        await setTimeout(crawlDelay * 1000)
        return originalGoto(url)
      }
      throw new Error('Blocked by robots.txt')
    }

    const workflow = workflows[publisher]
    if (workflow.timeout) {
      page.setDefaultNavigationTimeout(workflow.timeout)
    }
    await page.goto(workflow.start)
    await workflow.getData(page, event)
    await browser.close()
  } catch (err) {
    event.reply('print', 'There was an unexpected error:\n')
    event.reply('print', `${err.stack}\n`)
  }
  event.reply('done')
})
