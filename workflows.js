'use strict'

const { debuglog } = require('util')
const debug = debuglog('scraper')
const xml2js = require('xml2js')

const printTsvLine = (link, title, members, event) => {
  event.reply('print', [link, title, members.join(';').replace(/[ \n]+/g, ' ')].join('\t') + '\n')
}

const workflows = {
  AMA: {
    start: 'https://jamanetwork.com/',
    getData: async (page, event) => {
      debug('Getting AMA journal names and links...')
      const publicationsList = await page.$$eval('div.widget-instance-PublicationDropdown a', (el) =>
        el.filter((el) => el.href.startsWith('http')).map((el) => { return { href: el.href, title: el.innerText } })
      )

      for (const publication of publicationsList) {
        if (publication.href.startsWith('https://jamanetwork.com/journals/archneurpsyc')) {
          continue
        }

        const links = [
          publication.href.replace(/\/[^/]+$/, '/editors-and-publishers'),
          publication.href.replace(/\/[^/]+$/, '/pages/about')
        ]
        for (const link of links) {
          const result = await page.goto(link)
          const status = result.status()
          debug(`Status: ${status}`)
          if (status === 200) {
            break
          }
        }

        const members = await page.$eval('body', (el) =>
        // Matching on San Francisco preceded by a space to keep it from matching job listings for San Francisco.
          el.innerText.split('\n').filter((val) => val.includes(' San Francisco')).map((val) => val.slice(0, val.indexOf(',')))
        )
        printTsvLine(publication.href, publication.title, members, event)
      }
    }
  },
  BMC: {
    start: 'https://www.biomedcentral.com/journals',
    getData: async (page, event) => {
      debug('Getting BMC board links...')
      const boardLinks = await page.$$eval('a.u-ml-8', (el) => {
        // Skip these links
        const skipLinks = [
          'https://www.biomedcentral.com/getpublished/peer-review-process',
          'https://cancercommun.biomedcentral.com/' // no longer published by BMC
        ]
        return el.filter((el) => !skipLinks.includes(el.href)).map((el) => `${el.href}about/editorial-board`)
      })

      for (const link of boardLinks) {
        debug(`Getting title and board from ${link}...`)
        await page.goto(link)
        const rawTitle = (await page.title())
        const title = rawTitle.substring(0, rawTitle.indexOf('|')).trim()
        debug(`Got title ${title}...`)
        const members = await page.$eval('body', (el) =>
          el.innerText.split('\n').filter((val) => val.includes('San Francisco'))
        )
        printTsvLine(link, title, members, event)
      }
    }
  },
  BMJ: {
    start: 'https://journals.bmj.com/',
    getData: async (page, event) => {
      debug('Getting BMJ journal titles and board links...')
      const journals = await page.$$eval('li.journal-title a', (el) => {
        return el.map((el) => { return { href: `${el.href}/pages/editorial-board/`, title: el.innerText } })
      })

      for (const { href, title } of journals) {
        debug(`Getting editorial board members from ${href}...`)
        await page.goto(href)
        const members = await page.$$eval('p', (el) => {
          const entries = el.filter((val) => val.innerText.includes('San Francisco'))
          return entries.map((el) => {
            const text = el.innerText
            return text.substring(0, text.indexOf('\n'))
          })
        }
        )
        printTsvLine(href, title, members, event)
      }
    }
  },
  LWW: {
    start: 'https://journals.lww.com/_layouts/15/oaks.journals/Sitemap_xml.aspx?format=xml',
    getData: async (page, event) => {
      const data = await page.$eval('body .pretty-print', (el) => el.innerText)
      const xml = await xml2js.parseStringPromise(data)
      const boardLinks = xml.sitemapindex.sitemap
        .map((value) => value.loc[0])
        .map((value) => value.replace(/_layouts\/15\/oaks\.journals\/sitemap_xml\.aspx$/, ''))

      let timeout = 30000 // 30 seconds
      page.setDefaultTimeout(timeout)
      const tryLinks = async (links, options) => {
        if (options?.backoff) {
          timeout = timeout * 2
          debug(`Increasing timeout to ${timeout}ms`)
          page.setDefaultTimeout(timeout)
        }
        let title
        for (const link of links) {
          debug(`Trying ${link}`)
          const result = await page.goto(link, { waitFor: 'networkidle2' })
          const status = result.status()
          debug(`Status: ${status}`)
          if (status === 404) {
            continue
          }
          title = (await page.title()).trim()
          if (title === 'Just a moment...') {
            debug('Awaiting navigation')
            try {
              await page.waitForSelector('#aspnetForm')
            } catch (e) {
              if (e.name === 'TimeoutError') {
                debug(`Timeout error on ${link}, trying again with backoff`)
                // TODO: stop at some point so you're not in an infinite loop?
                title = (await tryLinks([link], { backoff: true }))
              } else {
                throw e
              }
            }
            title = (await page.title()).trim()
          }
          debug(`Got title ${title}`)
          if (!title.startsWith('Page Nor Found')) {
            break
          }
        }
        if (!title) {
          console.warn(`Page not found for ${links}`)
        }
        return title
      }

      for (let i = 0; i < boardLinks.length; i++) {
        const linksToTry = [
          boardLinks[i] + 'Pages/editorialboard.aspx',
          boardLinks[i] + 'Pages/JournalMasthead.aspx',
          boardLinks[i] + 'Pages/JournalContactsEditorialBoard.aspx',
          boardLinks[i] + 'Pages/editorialadvisoryboard.aspx',
          boardLinks[i] + 'Pages/publicationstaff.aspx',
          boardLinks[i] + 'Pages/aboutthejournal.aspx'
        ]
        const title = await tryLinks(linksToTry)

        debug(`Title: ${title}`)

        const members = await page.$$eval('p', (els) => els.map((val) => val.innerText.replace(/[\u200B-\u200D\uFEFF]/g, '')).filter((val) => val.includes('San Francisco')))
        printTsvLine(boardLinks[i], title, members, event)
      }
    }
  },
  Nature: {
    start: 'https://www.nature.com/siteindex',
    getData: async (page, event) => {
      debug('Getting Nature board links...')
      // Skip these links
      const data = await page.$$eval('#journals-az ul:not(.alpha-index) a', (el) => {
        return el.map(el => { return { title: el.innerText, link: el.href } })
      })

      for (let i = 0; i < data.length; i++) {
        const { link, title } = data[i]
        debug(`Title: ${title}`)

        // TODO: For at least one journal (bdj, British Dental Journal), the
        // editorial board is on the /about page under the #editors hash.
        // That practice will require special handling to avoid false positives.
        // We want to confirm that the editorial board (or at least the id
        // #editors) is actually there. For the other URLs, we're just checking
        // for page-not-found.

        const linksToTry = [
          link + '/editors',
          link + '/about/editors',
          link + '/about/editorial-board',
          link + '/about/editorialboard',
          link + '/about/editor'
        ]

        let status
        let editorsLink
        for (editorsLink of linksToTry) {
          debug(`Trying ${editorsLink}`)
          const result = await page.goto(editorsLink, { waitFor: 'networkidle2' })
          status = result.status()
          debug(`Status: ${status}`)
          if (status !== 404) {
            break
          }
        }

        if (status === 404) {
          console.log(`Editor page not found for ${title} (${link})\t\t`)
          continue
        }

        const members = await page.$$eval('p', (els) => els.map((val) => val.innerText.replace(/\n/g, ' ').match(/(.+)(?=San Francisco|UCSF)/))
          .filter(val => val !== null)
          .map(val => val[1])
          .map(val => val.substring(0, val.indexOf(' University of California')) || val)
          .map(val => val.trim())
        )

        printTsvLine(editorsLink, title, members, event)
      }
    }
  },
  // PLoS: {
  //   // TODO: This isn't finished. Finish it.
  //   start: 'https://plos.org/publish/submit/',
  //   getData: async (page, event) => {
  //     debug('Getting PLoS journal links...')
  //     const publicationsList = await page.$$eval('a', (el) =>
  //       el.filter((el) => el.innerText === 'Journal Information').map((el) => { return { href: el.href } })
  //     )

  //     // PLoS One will probably be a lot different than the others.

  //     for (const publication of publicationsList) {
  //       const links = [
  //         publication.href.replace(/\/[^/]+$/, '/editorial-board'),
  //         publication.href.replace(/\/[^/]+$/, '/editors-and-publishers'),
  //         publication.href.replace(/\/[^/]+$/, '/pages/about'),
  //       ]
  //       for (const link of links) {
  //         const result = await page.goto(link)
  //         const status = result.status()
  //         debug(`Status: ${status}`)
  //         if (status === 200) {
  //           break
  //         }
  //       }

  //       const members = await page.$eval('body', (el) =>
  //       // Matching on San Francisco preceded by a space to keep it from matching job listings for San Francisco.
  //         el.innerText.split('\n').filter((val) => val.includes(' San Francisco')).map((val) => val.slice(0, val.indexOf(',')))
  //       )
  //       printTsvLine(publication.href, publication.title, members, event)
  //     }
  //   }
  // },
  Springer: {
    start: 'https://link.springer.com/journals/a/1',
    getData: async (page, event) => {
      const publicationsList = []
      debug('Getting Springer journal names and links...')
      let morePages = true

      const moreLinks = await page.$$eval('a.c-atoz-navigation__link', (el) => {
        return el.map(el => el.href)
      })

      while (moreLinks.length) {
        while (morePages) {
          const morePublications = await page.$$eval('a.c-atoz-list__link', (el) => {
            return el.map(el => { return { title: el.innerText, link: el.href } })
          })
          publicationsList.push(...morePublications)

          debug(`Found ${publicationsList.length} journal titles so far...`)

          // Check for "Next" link and follow it if it exists.
          const next = await page.$x("//a[contains(., 'Next')]")
          if (next.length > 0) {
            await next[0].click()
            await page.waitForNavigation()
          } else {
            morePages = false
          }
        }

        await page.goto(moreLinks.shift())
        morePages = true
      }

      for (const publication of publicationsList) {
        const editorsLink = publication.link
          .replace('link.springer.com', 'springer.com')
          .replace(/volumes.?and.?issues\/?/i, '')
          .concat('/editors')
        // TODO: If this fails, maybe look for "Editorial Board" link? And if not,
        // there, look for "Submission Guidelines" link, follow it, and look for
        // "Editorial Board" there? Maybe don't even bother with the string
        // munging above and do this instead? Although we can ignore any BMC
        // domains because we already did them.

        debug(`Navigating to ${editorsLink}`)
        await page.goto(editorsLink)
        // TODO: This returns the location or institution a lot and not always
        // the name.
        const members = await page.$eval('body', (el) =>
          el.innerText.split('\n')
            .filter((val) => /San Francisco|UCSF/.test(val))
            .map((val) => val.slice(0, val.indexOf('(')))
        )
        printTsvLine(publication.title, publication.link, members, event)
      }
    }
  },
  Wiley: {
    start: 'https://onlinelibrary.wiley.com/action/showPublications?PubType=journal&startPage=&alphabetRange=a',
    getData: async (page, event) => {
      const publicationsList = []
      let currentLetter = 'a'
      debug('Getting Wiley journal names and links...')
      let pageLoaded = true

      while (pageLoaded) {
        while (pageLoaded) {
          const publicationsThisPage = await page.$$eval('a.visitable', (el) => {
            return el.map((el) => { return { title: el.innerText, href: el.href } })
          })
          publicationsList.push(...publicationsThisPage)

          const moreLinks = await page.$$eval('a.pagination__btn--next', (el) => {
            return el.map(el => el.href)
          })
          if (moreLinks.length > 0) {
            await page.goto(moreLinks[0])
            pageLoaded = true
          } else {
            pageLoaded = false
          }
        }
        currentLetter = String.fromCharCode(currentLetter.charCodeAt(0) + 1)
        if (currentLetter <= 'z') {
          await page.goto(`https://onlinelibrary.wiley.com/action/showPublications?PubType=journal&startPage=&alphabetRange=${currentLetter}`)
          pageLoaded = true
        }
      }

      for (const publication of publicationsList) {
        try {
          await page.goto(publication.href)
          const editorialBoardLink = await page.$$eval(
            'a.sub-menu-item',
            (el) => el.filter((el) => el.innerText === 'Editorial Board').map((el) => el.href)[0]
          )
          if (typeof editorialBoardLink !== 'string') {
            debug(`No editorial board link found for ${publication.title} (${publication.href})`)
            continue
          }
          await page.goto(editorialBoardLink)
          const members = await page.$eval('body', (el) =>
            el.innerText.split('\n').filter((val) => /San Francisco|UCSF/.test(val)).map((val) => val.replaceAll(',', ' '))
          )
          printTsvLine(publication.href, publication.title, members, event)
        } catch (e) {
          debug(`Error getting editorial board for ${publication.title} (${publication.href})`)
          debug(e)
        }
      }
    }
  }
}

module.exports = workflows
