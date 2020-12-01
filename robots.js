'use strict'

const robots = require('robots-txt-parser')()

const canCrawl = async (url) => {
  // useRobotsFor() needs to be called twice here. Otherwise canCrawl() will
  // initially return true no matter what at first before returning the correct
  // result.
  // Ref: https://github.com/chrisakroyd/robots-txt-parser/issues/5
  await robots.useRobotsFor(url)
  await robots.useRobotsFor(url)
  return robots.canCrawl(url)
}

module.exports = exports = { canCrawl, getCrawlDelay: robots.getCrawlDelay.bind(robots) }
