'use strict'

const { debuglog } = require('util')
const { setTimeout } = require('node:timers/promises')
const debug = debuglog('scraper')

const printTsvLine = (link, title, members, event) => {
  event.reply('print', [link, title, members.join(';').replace(/[ \n]+/g, ' ')].join('\t') + '\n')
}

const workflows = {
  ASCO: {
    start: 'https://ascopubs.org/',
    getData: async (page, event) => {
      debug('Getting ASCO journal links...')
      const journalLinks = await page.$$eval('a', (el) =>
        el.filter((el) => el.href.startsWith('https://ascopubs.org/journal/')).map((el) => el.href)
      )
      const deduppedLinks = [...new Set(journalLinks)]
      const publicationsList = []
      for (const link of deduppedLinks) {
        debug(`Getting title from ${link}...`)
        await page.goto(link)
        const title = await page.$eval('title', (el) => el.innerText)
        if (!title.endsWith('Educational Book')) {
          publicationsList.push({ href: link, title })
        } else {
          debug(`Skipping ${title}...`)
        }
      }

      for (const publication of publicationsList) {
        debug(`Getting editorial board members from ${publication.href}...`)
        await page.goto(`${publication.href.replace('/journal', '')}/about/editorial-roster`)
        const members = await page.$eval('div.tab-content', (el) => {
          const entries = el.innerText.split('\n').filter((val) => val.includes('San Francisco') || val.includes('UCSF'))
          return entries
        })
        printTsvLine(publication.href, publication.title, members, event)
      }
    }
  },
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
  Elsevier: {
    start: 'https://www.sciencedirect.com/browse/journals-and-books?contentType=JL',
    getData: async (page, event) => {
      // TODO: This should be done for all workflows, probably.
      await page.setRequestInterception(true)
      page.on('request', (req) => {
        if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
          req.abort()
        } else {
          req.continue()
        }
      })
      const publicationsList = []
      debug('Getting Elsevier journal names and links...')

      const links = await page.$$eval('a.js-publication-title', (el) => {
        return el.map(el => { return { title: el.innerText, link: el.href } })
      })
      publicationsList.push(...links)
      let previousTitle = links[0].title

      debug('Got first set of journal links....')
      while (true) {
        debug('Waiting for next-page link to appear on page...')
        await page.waitForSelector('button[aria-label="Next page"]')

        debug('Getting next page link...')
        const linkIsDisabled = await page.$eval('button[aria-label="Next page"]', (el) => el.disabled)
        if (linkIsDisabled) {
          debug('Next page link is disabled, no more links...')
          break
        }
        debug('Clicking next page link...')
        await page.click('button[aria-label="Next page"]')

        while (await page.$eval('a.js-publication-title', (el) => el.innerText) === previousTitle) {
          debug('Waiting for page to load...')
          await setTimeout(100)
        }

        debug('Getting journal links...')
        const links = await page.$$eval('a.js-publication-title', (el) => {
          return el.map(el => { return { title: el.innerText, link: el.href } })
        })
        publicationsList.push(...links)
        debug(`Previous first title: ${previousTitle}, current first title: ${links[0].title}`)
        previousTitle = links[0].title
      }

      debug(`Retrieved ${publicationsList.length} journal links...`)
      for (const publication of publicationsList) {
        // debug('Chilling out for 2 seconds before getting editorial board...')
        // await setTimeout(2000)

        const editorsLink = publication.link + '/about/editorial-board'
        debug(`Navigating to ${editorsLink}...`)
        try {
          await page.goto(editorsLink, { waitFor: 'networkidle2' })
        } catch (e) {
          debug(`Error navigating to ${editorsLink}: ${e}`)
          // It's probably a timeout on an image or something and it's probably fine to continue. ¯\_(ツ)_/¯
          continue
        }

        const board = await page.$$eval('div.editor-group', (elements) => elements.map((el) => el.innerText))
        debug('Full board: ' + JSON.stringify(board))
        const members = board.filter((val) => /San Francisco|UCSF/.test(val))
        debug('UCSF members: ' + JSON.stringify(members))
        printTsvLine(publication.title, publication.link, members, event)
      }
    }
  },
  // TODO: Need to find an XML parser that is maintained.
  // Until then, this code is broken. :-(
  // LWW: {
  //   start: 'https://journals.lww.com/_layouts/15/oaks.journals/Sitemap_xml.aspx?format=xml',
  //   getData: async (page, event) => {
  //     const data = await page.$eval('body .pretty-print', (el) => el.innerText)
  //     // const xml = await xml2js.parseStringPromise(data)
  //     const boardLinks = xml.sitemapindex.sitemap
  //       .map((value) => value.loc[0])
  //       .map((value) => value.replace(/_layouts\/15\/oaks\.journals\/sitemap_xml\.aspx$/, ''))

  //     let timeout = 30000 // 30 seconds
  //     page.setDefaultTimeout(timeout)
  //     const tryLinks = async (links, options) => {
  //       if (options?.backoff) {
  //         timeout = timeout * 2
  //         debug(`Increasing timeout to ${timeout}ms`)
  //         page.setDefaultTimeout(timeout)
  //       }
  //       let title
  //       for (const link of links) {
  //         debug(`Trying ${link}`)
  //         const result = await page.goto(link, { waitFor: 'networkidle2' })
  //         const status = result.status()
  //         debug(`Status: ${status}`)
  //         if (status === 404) {
  //           continue
  //         }
  //         title = (await page.title()).trim()
  //         if (title === 'Just a moment...') {
  //           debug('Awaiting navigation')
  //           try {
  //             await page.waitForSelector('#aspnetForm')
  //           } catch (e) {
  //             if (e.name === 'TimeoutError') {
  //               debug(`Timeout error on ${link}, trying again with backoff`)
  //               // TODO: stop at some point so you're not in an infinite loop?
  //               title = (await tryLinks([link], { backoff: true }))
  //             } else {
  //               throw e
  //             }
  //           }
  //           title = (await page.title()).trim()
  //         }
  //         debug(`Got title ${title}`)
  //         if (!title.startsWith('Page Nor Found')) {
  //           break
  //         }
  //       }
  //       if (!title) {
  //         console.warn(`Page not found for ${links}`)
  //       }
  //       return title
  //     }

  //     for (let i = 0; i < boardLinks.length; i++) {
  //       const linksToTry = [
  //         boardLinks[i] + 'Pages/editorialboard.aspx',
  //         boardLinks[i] + 'Pages/JournalMasthead.aspx',
  //         boardLinks[i] + 'Pages/JournalContactsEditorialBoard.aspx',
  //         boardLinks[i] + 'Pages/editorialadvisoryboard.aspx',
  //         boardLinks[i] + 'Pages/publicationstaff.aspx',
  //         boardLinks[i] + 'Pages/aboutthejournal.aspx'
  //       ]
  //       const title = await tryLinks(linksToTry)

  //       debug(`Title: ${title}`)

  //       const members = await page.$$eval('p', (els) => els.map((val) => val.innerText.replace(/[\u200B-\u200D\uFEFF]/g, '')).filter((val) => val.includes('San Francisco')))
  //       printTsvLine(boardLinks[i], title, members, event)
  //     }
  //   }
  // },
  'Mary Ann Liebert': {
    timeout: 300000,
    start: 'https://home.liebertpub.com/publications/a-z',
    getData: async (page, event) => {
      debug('Getting Mary Ann Liebert board links...')
      const data = await page.$$eval('a.pub-title', (el) => {
        return el.map(el => { return { title: el.innerText, link: `${el.href}/editorial-board` } })
      })

      const getMembers = async (page, selector) => {
        return await page.$$eval(selector, (els) => els.map((val) => val.innerText.replace(/[\u200B-\u200D\uFEFF]/g, '')).filter((val) => val.includes('San Francisco') || val.includes('UCSF')))
      }

      for (let i = 0; i < data.length; i++) {
        const { link, title } = data[i]
        debug(`Title: ${title}`)

        await page.goto(link, { waitFor: 'networkidle2' })

        let members = await getMembers(page, 'div.editorial p')
        if (members.length === 0) {
          members = await getMembers(page, '.member')
        }
        printTsvLine(title, link, members, event)
      }
    }
  },
  // TODO: Nature looks busted. Fix it.
  // Nature: {
  //   start: 'https://www.nature.com/siteindex',
  //   getData: async (page, event) => {
  //     debug('Getting Nature board links...')
  //     // Skip these links
  //     const data = await page.$$eval('#journals-az ul:not(.alpha-index) a', (el) => {
  //       return el.map(el => { return { title: el.innerText, link: el.href } })
  //     })

  //     for (let i = 0; i < data.length; i++) {
  //       const { link, title } = data[i]
  //       debug(`Title: ${title}`)

  //       // TODO: For at least one journal (bdj, British Dental Journal), the
  //       // editorial board is on the /about page under the #editors hash.
  //       // That practice will require special handling to avoid false positives.
  //       // We want to confirm that the editorial board (or at least the id
  //       // #editors) is actually there. For the other URLs, we're just checking
  //       // for page-not-found.

  //       const linksToTry = [
  //         link + '/editors',
  //         link + '/about/editors',
  //         link + '/about/editorial-board',
  //         link + '/about/editorialboard',
  //         link + '/about/editor'
  //       ]

  //       let status
  //       let editorsLink
  //       for (editorsLink of linksToTry) {
  //         debug(`Trying ${editorsLink}`)
  //         const result = await page.goto(editorsLink, { waitFor: 'networkidle2' })
  //         status = result.status()
  //         debug(`Status: ${status}`)
  //         if (status !== 404) {
  //           break
  //         }
  //       }

  //       if (status === 404) {
  //         console.log(`Editor page not found for ${title} (${link})\t\t`)
  //         continue
  //       }

  //       const members = await page.$$eval('p', (els) => els.map((val) => val.innerText.replace(/\n/g, ' ').match(/(.+)(?=San Francisco|UCSF)/))
  //         .filter(val => val !== null)
  //         .map(val => val[1])
  //         .map(val => val.substring(0, val.indexOf(' University of California')) || val)
  //         .map(val => val.trim())
  //       )

  //       printTsvLine(editorsLink, title, members, event)
  //     }
  //   }
  // },
  Oxford: {
    start: 'https://academic.oup.com/journals/pages/journals_a_to_z',
    getData: async (page, event) => {
      debug('Getting Oxford journal links...')
      const journals = await page.$$eval(
        '.secondaryContent a',
        (el) => el.map((val) => { return { title: val.innerHTML, href: val.href } }).filter((val) => /^https:\/\/academic\.oup\.com\//.test(val.href) && !/#[A-Z]$/.test(val.href))
      )
      for (let i = 0; i < journals.length; i++) {
        const linkBase = journals[i].href.replace(/\/pages\/.*$/, '')
        let link = `${linkBase}/pages/Editorial_Board`
        const title = journals[i].title
        debug(`Trying ${link} for ${title}`)
        let result = await page.goto(link, { waitFor: 'networkidle2' })
        let status = result.status()
        debug(`Status: ${status}`)
        let members
        if (status === 200) {
          members = await page.$$eval('p', (els) => els.map((val) => val.innerText).filter((val) => /San Francisco|UCSF/.test(val)))
          printTsvLine(link, title, members, event)
          continue
        }

        link = `${linkBase}/pages/editorial-board`
        debug(`Trying ${link} for ${title}`)
        result = await page.goto(link, { waitFor: 'networkidle2' })
        status = result.status()
        debug(`Status: ${status}`)
        if (status === 200) {
          members = await page.$$eval('nameGroup', (els) => els.map((val) => val.innerText.replaceAll('\n', '')).filter((val) => /San Francisco|UCSF/.test(val)))
          printTsvLine(link, title, members, event)
          continue
        }
        debug(`Can not find editorial board for ${title} (${linkBase})`)
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
  SAGE: {
    // TODO: Check for a next-page link to see if the 2000 parameter needs to be increased
    // or if this needs to be done in a loop (if SAGE decides to limit the number of journals
    // returned in a single request).
    timeout: 120000,
    start: 'https://journals.sagepub.com/action/showPublications?startPage=0&pageSize=2000',
    getData: async (page, event) => {
      const tryLink = async (link, timeout) => {
        page.setDefaultNavigationTimeout(timeout)
        let result
        try {
          result = await page.goto(link)
        } catch (e) {
          // TODO: Stop at some point if this keeps happening.
          if (e.name === 'TimeoutError') {
            timeout = timeout * 2
            debug(`Timeout error on ${link}, increasing timeout to ${timeout} and trying again`)
            return await tryLink(link, timeout)
          } else {
            throw e
          }
        }
        return result
      }

      debug('Getting SAGE journal links...')
      const publicationsList = await page.$$eval('.item__title a', (el) =>
        el.map((el) => { return { title: el.innerText, href: el.href } })
      )

      for (const publication of publicationsList) {
        let result = await tryLink(publication.href, 60000)
        let status = result.status()
        debug(`Status: ${status}`)
        if (status === 200) {
          let href
          try {
            href = await page.$eval('a[data-id="view-editorial-board"]', (el) => el.href)
          } catch (e) {
            debug(`Skipping ${publication.title} (${publication.href}) because it does not have an editorial board. It is probably no longer published.`)
            continue
          }
          result = await tryLink(href, 60000)
          status = result.status()
          if (status === 200) {
            const members = await page.$$eval('div.editorial-board tr', (els) =>
              els.map((val) => val.innerText).filter((val) => /San Francisco|UCSF/.test(val))
            )
            members.map((val) => val.replaceAll('\t', ', '))
            printTsvLine(href, publication.title, members, event)
          } else {
            throw new Error(`Can not find editorial board for ${publication.title} (${href}): ${status}`)
          }
        } else {
          throw new Error(`Can not find editorial board for ${publication.title} (${publication.href}): ${status}`)
        }
      }
    }
  },
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
  'Taylor & Francis': {
    timeout: 300000,
    start: 'https://www.tandfonline.com/action/showPublications?pubType=journal&startPage=&pageSize=99999',
    getData: async (page, event) => {
      debug('Getting Taylor & Francis journal names and links...')
      const publications = await page.$$eval('.art_title a', (el) => {
        return el.map((el) => { return { title: el.innerText, link: el.href } })
      })
      for (const publication of publications) {
        const editorialBoardLink = publication.link.replace('/journals/', '/action/journalInformation?show=editorialBoard&journalCode=')
        // TODO: robots-txt-parser is very buggy and I need to find a replacement. It returns a crawl delay of 0 for this site.
        //       The correct value is 1 so let's make sure we do that so they don't block us.
        await setTimeout(1000)
        await page.goto(editorialBoardLink)
        const members = await page.$eval('.stJournal', (el) => {
          return el.innerText.split('\n')
            .filter((val) => /San Francisco|UCSF/.test(val))
        })
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
