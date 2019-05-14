import puppeteer from 'puppeteer'
import {
    BaseURLOptions,
    ensureHasExternalService,
    ensureLoggedIn,
    getTokenWithSelector,
    launchBrowser,
    PageOptions,
    readEnvString,
} from '../../../shared/src/util/e2e-test-util'

const PHABRICATOR_BASE_URL = 'http://127.0.0.1'

async function phabricatorLogin({ page }: PageOptions): Promise<void> {
    await page.goto(PHABRICATOR_BASE_URL)
    await page.waitForSelector('.phabricator-wordmark')
    if (await page.$('input[name=username]')) {
        await page.type('input[name=username]', 'admin')
        await page.type('input[name=password]', 'sourcegraph')
        await page.click('button[name="__submit__"]')
    }
    await page.waitForSelector('.phabricator-core-user-menu')
}

async function repositoryCloned({ page }: PageOptions): Promise<void> {
    await page.goto(PHABRICATOR_BASE_URL + '/source/mux/manage/status/')
    try {
        await getTokenWithSelector(page, 'Fully Imported', 'td.phui-status-item-target')
    } catch (err) {
        console.error(err)
        await new Promise<void>(resolve => setTimeout(resolve, 1000))
        await repositoryCloned({ page })
    }
}

async function addPhabricatorRepo({ page }: PageOptions): Promise<void> {
    // Add new repo to Diffusion
    await page.goto(PHABRICATOR_BASE_URL + '/diffusion/edit/?vcs=git')
    await page.waitForSelector('input[name=shortName]')
    await page.type('input[name=name]', 'gorilla/mux')
    await page.type('input[name=callsign]', 'MUX')
    await page.type('input[name=shortName]', 'mux')
    await page.click('button[type=submit]')
    // Configure it to clone github.com/gorilla/mux
    await page.goto(PHABRICATOR_BASE_URL + '/source/mux/uri/edit/')
    await page.waitForSelector('input[name=uri]')
    await page.type('input[name=uri]', 'https://github.com/gorilla/mux.git')
    await page.select('select[name=io]', 'observe')
    await page.select('select[name=display]', 'always')
    const saveRepo = await getTokenWithSelector(page, 'Create Repository URI', 'button')
    await saveRepo.click()
    // Activate the repo and wait for it to clone
    await page.goto(PHABRICATOR_BASE_URL + '/source/mux/manage/')
    // await page.waitForSelector('a[href="/source/mux/edit/activate/"]')
    // await page.click('a[href="/source/mux/edit/activate/"]')
    // await page.waitForSelector('form[action="/source/mux/edit/activate/"]')
    // const activateRepo = await getTokenWithSelector(page, 'Activate Repository', 'button')
    // await activateRepo.click()
    await repositoryCloned({ page })
    // Configure the repository mappings
    await page.goto(PHABRICATOR_BASE_URL + '/config/edit/sourcegraph.callsignMappings/')
    await page.waitForSelector('textarea[name=value]')
    await page.type(
        'textarea[name=value]',
        `[
        {
          "path": "github.com/gorilla/mux",
          "callsign": "MUX"
        }
      ]`
    )
    const setCallsignMappings = await getTokenWithSelector(page, 'Save Config Entry', 'button')
    await setCallsignMappings.click()
}

async function init({
    page,
    baseURL,
    gitHubToken,
}: PageOptions & BaseURLOptions & { gitHubToken: string }): Promise<void> {
    await ensureLoggedIn({ page, baseURL })
    await ensureHasExternalService({
        page,
        baseURL,
        kind: 'github',
        displayName: 'github.com',
        config: JSON.stringify({
            url: 'https://github.com',
            token: gitHubToken,
            repos: ['gorilla/mux'],
            repositoryQuery: ['none'],
        }),
        ensureRepos: ['gorilla/mux'],
    })
    await phabricatorLogin({ page })
    await addPhabricatorRepo({ page })
}

describe('Sourcegraph Phabricator extension', () => {
    let browser: puppeteer.Browser
    let page: puppeteer.Page
    const baseURL = readEnvString({ variable: 'SOURCEGRAPH_BASE_URL', defaultValue: 'http://127.0.0.1:3080' })
    const gitHubToken = readEnvString({ variable: 'GITHUB_TOKEN' })

    beforeAll(async () => {
        browser = await launchBrowser(['--window-size=1600,1200'])
        page = await browser.newPage()
        await init({ page, baseURL, gitHubToken })
    }, 360 * 1000)

    beforeEach(async () => {
        page = await browser.newPage()
    })

    it('works', async () => {
        await Promise.resolve()
    })
})
