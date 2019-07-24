import * as jsonc from '@sqs/jsonc-parser'
import * as jsoncEdit from '@sqs/jsonc-parser/lib/edit'
import pRetry from 'p-retry'
import puppeteer from 'puppeteer'
import { OperationOptions } from 'retry'
import { dataOrThrowErrors, gql, GraphQLResult } from '../../../shared/src/graphql/graphql'
import * as GQL from '../../../shared/src/graphql/schema'

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

export interface BaseURLOptions {
    baseURL: string
}

export interface PageOptions {
    page: puppeteer.Page
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
