import * as jsonc from '@sqs/jsonc-parser'
import * as jsoncEdit from '@sqs/jsonc-parser/lib/edit'
import * as os from 'os'
import pRetry from 'p-retry'
import puppeteer from 'puppeteer'
import { OperationOptions } from 'retry'
import { Key } from 'ts-key-enum'
import { dataOrThrowErrors, gql, GraphQLResult } from '../graphql/graphql'
import * as GQL from '../graphql/schema'

/**
 * Retry function with more sensible defaults for e2e test assertions
 *
 * @param fn The async assertion function to retry
 * @param options Option overrides passed to pRetry
 */
export const retry = (fn: (attempt: number) => Promise<any>, options: OperationOptions = {}) =>
    pRetry(fn, { factor: 1, ...options })

/**
 * Looks up an environment variable and parses it as a boolean. Throws when not
 * set and no default is provided, or if parsing fails.
 */
export function readEnvBoolean({
    variable: variable,
    defaultValue,
}: {
    variable: string
    defaultValue?: boolean
}): boolean {
    const value = process.env[variable]

    if (!value) {
        if (defaultValue === undefined) {
            throw new Error(`Environment variable ${variable} must be set.`)
        }
        return defaultValue
    }

    try {
        return Boolean(JSON.parse(value))
    } catch (e) {
        throw new Error(`Incorrect environment variable ${variable}=${value}. Must be truthy or not set at all.`)
    }
}

/**
 * Looks up an environment variable. Throws when not set and no default is
 * provided.
 */
export function readEnvString({ variable, defaultValue }: { variable: string; defaultValue?: string }): string {
    const value = process.env[variable]

    if (!value) {
        if (defaultValue === undefined) {
            throw new Error(`Environment variable ${variable} must be set.`)
        }
        return defaultValue
    }
    return value
}

export interface PageOptions {
    page: puppeteer.Page
}

interface ReplaceTextOptions extends PageOptions {
    selector: string
    newText: string
    method?: ReplaceTextMethod
}

/**
 * Specifies how `replaceText` will select the content of the element. No
 * single method works in all cases:
 *
 * - Meta+A doesn't work in input boxes https://github.com/GoogleChrome/puppeteer/issues/1313
 * - selectall doesn't work in the Monaco editor
 */
type ReplaceTextMethod = 'selectall' | 'keyboard'

export async function replaceText({
    page,
    selector,
    newText,
    method = 'selectall',
}: ReplaceTextOptions): Promise<void> {
    const selectAllByMethod: Record<ReplaceTextMethod, () => Promise<void>> = {
        selectall: async () => {
            await page.evaluate(() => document.execCommand('selectall', false))
        },
        keyboard: async () => {
            const modifier = os.platform() === 'darwin' ? Key.Meta : Key.Control
            await page.keyboard.down(modifier)
            await page.keyboard.press('a')
            await page.keyboard.up(modifier)
        },
    }

    // The Monaco editor sometimes detaches nodes from the DOM, causing
    // `click()` to fail unpredictably.
    await retry(async () => {
        await page.waitForSelector(selector)
        await page.click(selector)
    })
    await selectAllByMethod[method]()
    await page.keyboard.press(Key.Backspace)
    await page.keyboard.type(newText)
}

export interface BaseURLOptions {
    baseURL: string
}

interface EnsureLoggedInOptions extends PageOptions, BaseURLOptions {
    email?: string
    username?: string
    password?: string
}

export async function ensureLoggedIn({
    page,
    baseURL,
    email = 'test@test.com',
    username = 'test',
    password = 'test',
}: EnsureLoggedInOptions): Promise<void> {
    await page.goto(baseURL)
    await page.evaluate(() => {
        localStorage.setItem('has-dismissed-browser-ext-toast', 'true')
        localStorage.setItem('has-dismissed-integrations-toast', 'true')
        localStorage.setItem('has-dismissed-survey-toast', 'true')
    })
    const url = new URL(await page.url())
    if (url.pathname === '/site-admin/init') {
        await page.type('input[name=email]', email)
        await page.type('input[name=username]', username)
        await page.type('input[name=password]', password)
        await page.click('button[type=submit]')
        await page.waitForNavigation()
    } else if (url.pathname === '/sign-in') {
        await page.type('input', username)
        await page.type('input[name=password]', password)
        await page.click('button[type=submit]')
        await page.waitForNavigation()
    }
}

export interface EnsureHasExternalServiceOptions extends PageOptions, BaseURLOptions {
    kind: string
    displayName: string
    config: string
    ensureRepos?: string[]
}

async function makeRequest<T = void>({
    page,
    url,
    init,
}: PageOptions & { url: string; init: RequestInit }): Promise<T> {
    const handle = await page.evaluateHandle((url, init) => fetch(url, init).then(r => r.json()), url, init as {})
    return handle.jsonValue()
}

async function makeGraphQLRequest<T extends GQL.IQuery | GQL.IMutation>({
    baseURL,
    page,
    request,
    variables,
}: PageOptions & BaseURLOptions & { request: string; variables: {} }): Promise<GraphQLResult<T>> {
    const nameMatch = request.match(/^\s*(?:query|mutation)\s+(\w+)/)
    const xhrHeaders = await page.evaluate(() => (window as any).context.xhrHeaders)
    const response = await makeRequest<GraphQLResult<T>>({
        page,
        url: `${baseURL}/.api/graphql${nameMatch ? '?' + nameMatch[1] : ''}`,
        init: {
            method: 'POST',
            body: JSON.stringify({ query: request, variables }),
            headers: {
                ...xhrHeaders,
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
        },
    })
    return response
}

export async function ensureHasCORSOrigin({
    baseURL,
    page,
    corsOriginURL,
}: BaseURLOptions & PageOptions & { corsOriginURL: string }): Promise<void> {
    const currentConfigResponse = await makeGraphQLRequest<GQL.IQuery>({
        baseURL,
        page,
        request: gql`
            query Site {
                site {
                    id
                    configuration {
                        id
                        effectiveContents
                        validationMessages
                    }
                }
            }
        `,
        variables: {},
    })
    const { site } = dataOrThrowErrors(currentConfigResponse)
    const currentConfig = site.configuration.effectiveContents
    const newConfig = modifyJSONC(currentConfig, ['corsOrigin'], oldCorsOrigin => {
        const urls = oldCorsOrigin ? oldCorsOrigin.value.split(' ') : []
        return (urls.includes(corsOriginURL) ? urls : [...urls, corsOriginURL]).join(' ')
    })
    const updateConfigResponse = await makeGraphQLRequest<GQL.IMutation>({
        baseURL,
        page,
        request: gql`
            mutation UpdateSiteConfiguration($lastID: Int!, $input: String!) {
                updateSiteConfiguration(lastID: $lastID, input: $input)
            }
        `,
        variables: { lastID: site.configuration.id, input: newConfig },
    })
    dataOrThrowErrors(updateConfigResponse)
}

function modifyJSONC(text: string, path: jsonc.JSONPath, f: (oldValue: jsonc.Node | undefined) => any): any {
    const old = jsonc.findNodeAtLocation(jsonc.parseTree(text), path)
    return jsonc.applyEdits(
        text,
        jsoncEdit.setProperty(text, path, f(old), {
            eol: '\n',
            insertSpaces: true,
            tabSize: 2,
        })
    )
}

export async function ensureHasExternalService({
    page,
    baseURL,
    kind,
    displayName,
    config,
    ensureRepos,
}: EnsureHasExternalServiceOptions): Promise<void> {
    await page.goto(baseURL + '/site-admin/external-services')
    await page.waitFor('.e2e-filtered-connection')
    await page.waitForSelector('.e2e-filtered-connection__loader', { hidden: true })

    // Matches buttons for deleting external services named ${displayName}.
    const deleteButtonSelector = `[data-e2e-external-service-name="${displayName}"] .e2e-delete-external-service-button`
    if (await page.$(deleteButtonSelector)) {
        const accept = async (dialog: puppeteer.Dialog) => {
            await dialog.accept()
            page.off('dialog', accept)
        }
        page.on('dialog', accept)
        await page.click(deleteButtonSelector)
    }

    await (await page.waitForSelector('.e2e-goto-add-external-service-page', { visible: true })).click()

    await (await page.waitForSelector(`.linked-external-service-card--${kind}`, { visible: true })).click()

    await replaceText({ page, selector: '#e2e-external-service-form-display-name', newText: displayName })

    // Type in a new external service configuration.
    await replaceText({
        page,
        selector: '.view-line',
        newText: config,
        method: 'keyboard',
    })
    await page.click('.e2e-add-external-service-button')
    await page.waitForSelector(`[data-e2e-external-service-name="${displayName}"]`)

    if (ensureRepos) {
        // Wait for repositories to sync.
        await page.goto(baseURL + '/site-admin/repositories?query=gorilla%2Fmux')
        await retry(async () => {
            await page.reload()
            await page.waitForSelector(`.repository-node[data-e2e-repository='github.com/gorilla/mux']`, {
                timeout: 5000,
            })
        })

        // Clone the repositories
        for (const slug of ensureRepos) {
            await page.goto(baseURL + `/site-admin/repositories?query=${encodeURIComponent(slug)}`)
            await page.waitForSelector(`.repository-node[data-e2e-repository='github.com/${slug}']`, {
                visible: true,
            })
            if (await page.$(`.repository-node[data-e2e-repository='github.com/${slug}'][data-e2e-enabled='false']`)) {
                await page.click(`.repository-node[data-e2e-repository='github.com/${slug}'] .e2e-enable-repository`)
                if (slug === 'sourcegraphtest/AlwaysCloningTest') {
                    await page.waitForSelector(
                        `.repository-node[data-e2e-repository='github.com/${slug}'][data-e2e-enabled='true']`,
                        { visible: true }
                    )
                } else {
                    await page.waitForSelector(
                        `.repository-node[data-e2e-repository='github.com/${slug}'][data-e2e-enabled='true'][data-e2e-cloned='true']`,
                        { visible: true }
                    )
                }
            }
        }
    }
}

export function launchBrowser(args: string[] = []): Promise<puppeteer.Browser> {
    if (process.getuid() === 0) {
        // TODO don't run as root in CI
        console.warn('Running as root, disabling sandbox')
        args = [...args, '--no-sandbox', '--disable-setuid-sandbox']
    }
    const launchOpt = {
        args,
        headless: readEnvBoolean({ variable: 'HEADLESS', defaultValue: false }),
        defaultViewport: null,
        appMode: true,
    }
    return puppeteer.launch(launchOpt)
}

export async function getTokenWithSelector(
    page: puppeteer.Page,
    token: string,
    selector: string
): Promise<puppeteer.ElementHandle> {
    const elements = await page.$$(selector)

    let element: puppeteer.ElementHandle<HTMLElement> | undefined
    for (const elem of elements) {
        const text = await page.evaluate(element => element.textContent, elem)
        if (text.trim() === token) {
            element = elem
            break
        }
    }

    if (!element) {
        throw new Error(`Unable to find token '${token}' with selector ${selector}`)
    }

    return element
}
