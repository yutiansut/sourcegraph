import * as path from 'path'
import puppeteer from 'puppeteer'
import { saveScreenshotsUponFailuresAndClosePage } from '../../../shared/src/util/screenshotReporter'
import { retry } from '../util/e2e-test-utils'
import { baseURL, createDriverForTest, Driver, gitHubToken, percySnapshot } from './util'

// 1 minute test timeout. This must be greater than the default Puppeteer
// command timeout of 30s in order to get the stack trace to point to the
// Puppeteer command that failed instead of a cryptic Jest test timeout
// location.
jest.setTimeout(1 * 60 * 1000)

// tslint:disable-next-line: no-empty

process.on('unhandledRejection', error => {
    console.error('Caught unhandledRejection:', error)
})

process.on('rejectionHandled', error => {
    console.error('Caught rejectionHandled:', error)
})

describe('e2e test suite', function(this: any): void {
    let driver: Driver

    async function init(): Promise<void> {
        const repoSlugs = [
            'gorilla/mux',
            'gorilla/securecookie',
            'sourcegraphtest/AlwaysCloningTest',
            'sourcegraph/godockerize',
            'sourcegraph/jsonrpc2',
            'sourcegraph/checkup',
            'sourcegraph/go-diff',
            'sourcegraph/vcsstore',
            'sourcegraph/go-vcs',
            'sourcegraph/appdash',
            'sourcegraph/sourcegraph-typescript',
        ]
        await driver.ensureLoggedIn()
        await driver.ensureHasExternalService({
            kind: 'github',
            displayName: 'e2e-test-github',
            config: JSON.stringify({
                url: 'https://github.com',
                token: gitHubToken,
                repos: repoSlugs,
                repositoryQuery: ['none'],
            }),
            ensureRepos: repoSlugs.map(slug => `github.com/${slug}`),
        })
    }

    // Start browser.
    beforeAll(
        async () => {
            driver = await createDriverForTest()
            await init()
        },
        // Cloning the repositories takes ~1 minute, so give initialization 2
        // minutes instead of 1 (which would be inherited from
        // `jest.setTimeout(1 * 60 * 1000)` above).
        2 * 60 * 1000
    )

    // Close browser.
    afterAll(async () => {
        if (driver) {
            await driver.close()
        }
    })

    // Take a screenshot when a test fails.
    saveScreenshotsUponFailuresAndClosePage(
        path.resolve(__dirname, '..', '..', '..'),
        path.resolve(__dirname, '..', '..', '..', 'puppeteer'),
        () => driver.page
    )

    // Clear local storage to reset sidebar selection (files or tabs) for each test
    beforeEach(async () => {
        if (driver) {
            await driver.page.evaluate(() => {
                localStorage.setItem('repo-rev-sidebar-last-tab', 'files')
            })
        }
    })

    describe('External services', () => {
        test('External service add, edit, delete', async () => {
            const displayName = 'e2e-github-test-2'
            await driver.ensureHasExternalService({
                kind: 'github',
                displayName,
                config:
                    '{"url": "https://github.myenterprise.com", "token": "initial-token", "repositoryQuery": ["none"]}',
            })
            await driver.page.goto(baseURL + '/site-admin/external-services')
            await (await driver.page.waitForSelector(
                `[data-e2e-external-service-name="${displayName}"] .e2e-edit-external-service-button`
            )).click()

            // Type in a new external service configuration.
            await driver.replaceText({
                selector: '.view-line',
                newText:
                    '{"url": "https://github.myenterprise.com", "token": "second-token", "repositoryQuery": ["none"]}',
                selectMethod: 'keyboard',
            })
            await driver.page.click('.e2e-update-external-service-button')
            // Must wait for the operation to complete, or else a "Discard changes?" dialog will pop up
            await driver.page.waitForSelector('.e2e-update-external-service-button:not([disabled])', { visible: true })

            await (await driver.page.waitForSelector('.list-group-item[href="/site-admin/external-services"]', {
                visible: true,
            })).click()

            const accept = async (dialog: puppeteer.Dialog) => {
                await dialog.accept()
                driver.page.off('dialog', accept)
            }
            driver.page.on('dialog', accept)
            await (await driver.page.waitForSelector(
                `[data-e2e-external-service-name="e2e-github-test-2"] .e2e-delete-external-service-button`,
                { visible: true }
            )).click()

            await driver.page.waitFor(
                () => !document.querySelector('[data-e2e-external-service-name="e2e-github-test-2"]')
            )
        })

        test('External service repositoryPathPattern', async () => {
            const repo = 'sourcegraph/go-blame' // Tiny repo, fast to clone
            const repositoryPathPattern = 'foobar/{host}/{nameWithOwner}'
            const slug = `github.com/${repo}`
            const pathPatternSlug = `foobar/github.com/${repo}`

            const config = {
                kind: 'github',
                displayName: 'e2e-test-github-repoPathPattern',
                config: JSON.stringify({
                    url: 'https://github.com',
                    token: gitHubToken,
                    repos: [repo],
                    repositoryPathPattern,
                }),
                // Make sure repository is named according to path pattern
                ensureRepos: [pathPatternSlug],
            }
            await driver.ensureHasExternalService(config)

            // Make sure repository slug without path pattern redirects to path pattern
            await driver.page.goto(baseURL + '/' + slug)
            await driver.assertWindowLocationPrefix('/' + pathPatternSlug)
        })
    })

    describe('Visual tests', () => {
        test('Repositories list', async () => {
            await driver.page.goto(baseURL + '/site-admin/repositories?query=gorilla%2Fmux')
            await driver.page.waitForSelector('a[href="/github.com/gorilla/mux"]', { visible: true })
            await percySnapshot(driver.page, 'Repositories list')
        })

        test('Search results repo', async () => {
            await driver.page.goto(baseURL + '/search?q=repo:%5Egithub.com/gorilla/mux%24')
            await driver.page.waitForSelector('a[href="/github.com/gorilla/mux"]', { visible: true })
            // Flaky https://github.com/sourcegraph/sourcegraph/issues/2704
            // await percySnapshot(page, 'Search results repo')
        })

        test('Search results file', async () => {
            await driver.page.goto(baseURL + '/search?q=repo:%5Egithub.com/gorilla/mux%24+file:%5Emux.go%24')
            await driver.page.waitForSelector('a[href="/github.com/gorilla/mux"]', { visible: true })
            // Flaky https://github.com/sourcegraph/sourcegraph/issues/2704
            // await percySnapshot(page, 'Search results file')
        })

        test('Search results code', async () => {
            await driver.page.goto(baseURL + '/search?q=repo:^github.com/gorilla/mux$ file:mux.go "func NewRouter"')
            await driver.page.waitForSelector('a[href="/github.com/gorilla/mux"]', { visible: true })
            // Flaky https://github.com/sourcegraph/sourcegraph/issues/2704
            // await percySnapshot(page, 'Search results code')
        })
    })

    describe('Theme switcher', () => {
        test('changes the theme', async () => {
            await driver.page.goto(baseURL + '/github.com/gorilla/mux/-/blob/mux.go')
            await driver.page.waitForSelector('.theme', { visible: true })
            const currentThemes = await driver.page.evaluate(() =>
                Array.from(document.querySelector('.theme')!.classList).filter(c => c.startsWith('theme-'))
            )
            expect(currentThemes).toHaveLength(1)
            await driver.page.click('.e2e-user-nav-item-toggle')
            await driver.page.select('.e2e-theme-toggle', 'dark')
            expect(
                await driver.page.evaluate(() =>
                    Array.from(document.querySelector('.theme')!.classList).filter(c => c.startsWith('theme-'))
                )
            ).toEqual(['theme-dark'])
            await driver.page.select('.e2e-theme-toggle', 'light')
            expect(
                await driver.page.evaluate(() =>
                    Array.from(document.querySelector('.theme')!.classList).filter(c => c.startsWith('theme-'))
                )
            ).toEqual(['theme-light'])
        })
    })

    describe('Repository component', () => {
        const blobTableSelector = '.e2e-blob > table'
        /**
         * @param line 1-indexed line number
         * @param spanOffset 1-indexed index of the span that's to be clicked
         */
        const clickToken = async (line: number, spanOffset: number): Promise<void> => {
            const selector = `${blobTableSelector} tr:nth-child(${line}) > td.code > div:nth-child(1) > span:nth-child(${spanOffset})`
            await driver.page.waitForSelector(selector, { visible: true })
            await driver.page.click(selector)
        }

        // expectedCount defaults to one because of we haven't specified, we just want to ensure it exists at all
        const getHoverContents = async (expectedCount = 1): Promise<string[]> => {
            const selector =
                expectedCount > 1 ? `.e2e-tooltip-content:nth-child(${expectedCount})` : `.e2e-tooltip-content`
            await driver.page.waitForSelector(selector, { visible: true })
            return await driver.page.evaluate(() =>
                // You can't reference hoverContentSelector in puppeteer's driver.page.evaluate
                Array.from(document.querySelectorAll('.e2e-tooltip-content')).map(t => t.textContent || '')
            )
        }
        const assertHoverContentContains = async (val: string, count?: number) => {
            expect(await getHoverContents(count)).toEqual(expect.arrayContaining([expect.stringContaining(val)]))
        }

        const clickHoverJ2D = async (): Promise<void> => {
            const selector = '.e2e-tooltip-go-to-definition'
            await driver.page.waitForSelector(selector, { visible: true })
            await driver.page.click(selector)
        }
        const clickHoverFindRefs = async (): Promise<void> => {
            const selector = '.e2e-tooltip-find-references'
            await driver.page.waitForSelector(selector, { visible: true })
            await driver.page.click(selector)
        }

        describe('file tree', () => {
            test('does navigation on file click', async () => {
                await driver.page.goto(
                    baseURL + '/github.com/sourcegraph/godockerize@05bac79edd17c0f55127871fa9c6f4d91bebf07c'
                )
                await (await driver.page.waitForSelector(`[data-tree-path="godockerize.go"]`, {
                    visible: true,
                })).click()
                await driver.assertWindowLocation(
                    '/github.com/sourcegraph/godockerize@05bac79edd17c0f55127871fa9c6f4d91bebf07c/-/blob/godockerize.go'
                )
            })

            test('expands directory on row click (no navigation)', async () => {
                await driver.page.goto(
                    baseURL + '/github.com/sourcegraph/jsonrpc2@c6c7b9aa99fb76ee5460ccd3912ba35d419d493d'
                )
                await driver.page.waitForSelector('.tree__row-icon', { visible: true })
                await driver.page.click('.tree__row-icon')
                await driver.page.waitForSelector('.tree__row--selected [data-tree-path="websocket"]', {
                    visible: true,
                })
                await driver.page.waitForSelector('.tree__row--expanded [data-tree-path="websocket"]', {
                    visible: true,
                })
                await driver.assertWindowLocation(
                    '/github.com/sourcegraph/jsonrpc2@c6c7b9aa99fb76ee5460ccd3912ba35d419d493d'
                )
            })

            test('does navigation on directory row click', async () => {
                await driver.page.goto(
                    baseURL + '/github.com/sourcegraph/jsonrpc2@c6c7b9aa99fb76ee5460ccd3912ba35d419d493d'
                )
                await driver.page.waitForSelector('.tree__row-label', { visible: true })
                await driver.page.click('.tree__row-label')
                await driver.page.waitForSelector('.tree__row--selected [data-tree-path="websocket"]', {
                    visible: true,
                })
                await driver.page.waitForSelector('.tree__row--expanded [data-tree-path="websocket"]', {
                    visible: true,
                })
                await driver.assertWindowLocation(
                    '/github.com/sourcegraph/jsonrpc2@c6c7b9aa99fb76ee5460ccd3912ba35d419d493d/-/tree/websocket'
                )
            })

            test('selects the current file', async () => {
                await driver.page.goto(
                    baseURL +
                        '/github.com/sourcegraph/godockerize@05bac79edd17c0f55127871fa9c6f4d91bebf07c/-/blob/godockerize.go'
                )
                await driver.page.waitForSelector('.tree__row--active [data-tree-path="godockerize.go"]', {
                    visible: true,
                })
            })

            test('shows partial tree when opening directory', async () => {
                await driver.page.goto(
                    baseURL +
                        '/github.com/sourcegraph/jsonrpc2@c6c7b9aa99fb76ee5460ccd3912ba35d419d493d/-/tree/websocket'
                )
                await driver.page.waitForSelector('.tree__row', { visible: true })
                expect(await driver.page.evaluate(() => document.querySelectorAll('.tree__row').length)).toEqual(1)
            })

            test('responds to keyboard shortcuts', async () => {
                const assertNumRowsExpanded = async (expectedCount: number) => {
                    expect(
                        await driver.page.evaluate(() => document.querySelectorAll('.tree__row--expanded').length)
                    ).toEqual(expectedCount)
                }

                await driver.page.goto(
                    baseURL +
                        '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/.travis.yml'
                )
                await driver.page.waitForSelector('.tree__row', { visible: true }) // waitForSelector for tree to render

                await driver.page.click('.tree')
                await driver.page.keyboard.press('ArrowUp') // arrow up to 'diff' directory
                await driver.page.waitForSelector('.tree__row--selected [data-tree-path="diff"]', { visible: true })
                await driver.page.keyboard.press('ArrowRight') // arrow right (expand 'diff' directory)
                await driver.page.waitForSelector('.tree__row--selected [data-tree-path="diff"]', { visible: true })
                await driver.page.waitForSelector('.tree__row--expanded [data-tree-path="diff"]', { visible: true })
                await driver.page.waitForSelector('.tree__row [data-tree-path="diff/testdata"]', { visible: true })
                await driver.page.keyboard.press('ArrowRight') // arrow right (move to nested 'diff/testdata' directory)
                await driver.page.waitForSelector('.tree__row--selected [data-tree-path="diff/testdata"]', {
                    visible: true,
                })
                await assertNumRowsExpanded(1) // only `diff` directory is expanded, though `diff/testdata` is expanded

                await driver.page.keyboard.press('ArrowRight') // arrow right (expand 'diff/testdata' directory)
                await driver.page.waitForSelector('.tree__row--selected [data-tree-path="diff/testdata"]', {
                    visible: true,
                })
                await driver.page.waitForSelector('.tree__row--expanded [data-tree-path="diff/testdata"]', {
                    visible: true,
                })
                await assertNumRowsExpanded(2) // `diff` and `diff/testdata` directories expanded

                await driver.page.waitForSelector('.tree__row [data-tree-path="diff/testdata/empty.diff"]', {
                    visible: true,
                })
                // select some file nested under `diff/testdata`
                await driver.page.keyboard.press('ArrowDown') // arrow down
                await driver.page.keyboard.press('ArrowDown') // arrow down
                await driver.page.keyboard.press('ArrowDown') // arrow down
                await driver.page.keyboard.press('ArrowDown') // arrow down
                await driver.page.waitForSelector(
                    '.tree__row--selected [data-tree-path="diff/testdata/empty_orig.diff"]',
                    {
                        visible: true,
                    }
                )

                await driver.page.keyboard.press('ArrowLeft') // arrow left (navigate immediately up to parent directory `diff/testdata`)
                await driver.page.waitForSelector('.tree__row--selected [data-tree-path="diff/testdata"]', {
                    visible: true,
                })
                await assertNumRowsExpanded(2) // `diff` and `diff/testdata` directories expanded

                await driver.page.keyboard.press('ArrowLeft') // arrow left
                await driver.page.waitForSelector('.tree__row--selected [data-tree-path="diff/testdata"]', {
                    visible: true,
                }) // `diff/testdata` still selected
                await assertNumRowsExpanded(1) // only `diff` directory expanded
            })
        })
        describe('symbol sidebar', () => {
            const listSymbolsTests = [
                {
                    name: 'lists symbols in file for Go',
                    filePath:
                        '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/cmd/go-diff/go-diff.go',
                    symbolNames: ['main', 'stdin', 'diffPath', 'fileIdx', 'main'],
                    symbolTypes: ['package', 'constant', 'variable', 'variable', 'function'],
                },
                {
                    name: 'lists symbols in another file for Go',
                    filePath:
                        '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/diff.go',
                    symbolNames: [
                        'diff',
                        'Stat',
                        'Stat',
                        'hunkPrefix',
                        'hunkHeader',
                        'diffTimeParseLayout',
                        'diffTimeFormatLayout',
                        'add',
                    ],
                    symbolTypes: [
                        'package',
                        'function',
                        'function',
                        'variable',
                        'constant',
                        'constant',
                        'constant',
                        'function',
                    ],
                },
                {
                    name: 'lists symbols in file for Python',
                    filePath:
                        '/github.com/sourcegraph/appdash@ebfcffb1b5c00031ce797183546746715a3cfe87/-/blob/python/appdash/sockcollector.py',
                    symbolNames: [
                        'RemoteCollector',
                        'sock',
                        '_debug',
                        '__init__',
                        '_log',
                        'connect',
                        'collect',
                        'close',
                    ],
                    symbolTypes: ['class', 'variable', 'variable', 'field', 'field', 'field', 'field', 'field'],
                },
                {
                    name: 'lists symbols in file for TypeScript',
                    filePath:
                        '/github.com/sourcegraph/sourcegraph-typescript@a7b7a61e31af76dad3543adec359fa68737a58a1/-/blob/server/src/cancellation.ts',
                    symbolNames: [
                        'createAbortError',
                        'Object',
                        'isAbortError',
                        'throwIfCancelled',
                        'tryCancel',
                        'toAxiosCancelToken',
                        'source',
                    ],
                    symbolTypes: ['constant', 'constant', 'constant', 'function', 'function', 'function', 'constant'],
                },
            ]

            for (const symbolTest of listSymbolsTests) {
                test(symbolTest.name, async () => {
                    await driver.page.goto(baseURL + symbolTest.filePath)

                    await (await driver.page.waitForSelector('[data-e2e-tab="symbols"]')).click()

                    await driver.page.waitForSelector('.e2e-symbol-name', { visible: true })

                    const symbolNames = await driver.page.evaluate(() =>
                        Array.from(document.querySelectorAll('.e2e-symbol-name')).map(t => t.textContent || '')
                    )
                    const symbolTypes = await driver.page.evaluate(() =>
                        Array.from(document.querySelectorAll('.e2e-symbol-icon')).map(
                            t => t.getAttribute('data-tooltip') || ''
                        )
                    )

                    expect(symbolNames).toEqual(symbolTest.symbolNames)
                    expect(symbolTypes).toEqual(symbolTest.symbolTypes)
                })
            }

            test('navigates to file on symbol click', async () => {
                const repoBaseURL =
                    baseURL + '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-'
                const symbolPath = '/blob/cmd/go-diff/go-diff.go#L19:2-19:10'

                await driver.page.goto(repoBaseURL + '/tree/cmd')

                await (await driver.page.waitForSelector('[data-e2e-tab="symbols"]')).click()

                await driver.page.waitForSelector('.e2e-symbol-name', { visible: true })

                await (await driver.page.waitForSelector(`.e2e-symbol-link[href*="${symbolPath}"]`, {
                    visible: true,
                })).click()
                await driver.assertWindowLocation(repoBaseURL + symbolPath, true)
            })
        })

        describe('directory page', () => {
            // TODO(slimsag:discussions): temporarily disabled because the discussions feature flag removes this component.
            /*
            it('shows a row for each file in the directory', async () => {
                await driver.page.goto(baseURL + '/github.com/gorilla/securecookie@e59506cc896acb7f7bf732d4fdf5e25f7ccd8983')
                await enableOrAddRepositoryIfNeeded()
                await driver.page.waitForSelector('.tree-page__entries-directories', { visible: true })
                await retry(async () =>
                    assert.equal(
                        await driver.page.evaluate(
                            () => document.querySelectorAll('.tree-page__entries-directories .tree-entry').length
                        ),
                        1
                    )
                )
                await retry(async () =>
                    assert.equal(
                        await driver.page.evaluate(
                            () => document.querySelectorAll('.tree-page__entries-files .tree-entry').length
                        ),
                        7
                    )
                )
            })
            */

            test('shows commit information on a row', async () => {
                await driver.page.goto(
                    baseURL + '/github.com/gorilla/securecookie@e59506cc896acb7f7bf732d4fdf5e25f7ccd8983',
                    {
                        waitUntil: 'domcontentloaded',
                    }
                )
                await driver.page.waitForSelector('.git-commit-node__message', { visible: true })
                await retry(async () =>
                    expect(
                        await driver.page.evaluate(
                            () => document.querySelectorAll('.git-commit-node__message')[2].textContent
                        )
                    ).toContain('Add fuzz testing corpus.')
                )
                await retry(async () =>
                    expect(
                        await driver.page.evaluate(() =>
                            document.querySelectorAll('.git-commit-node-byline')[2].textContent!.trim()
                        )
                    ).toContain('Kamil Kisiel')
                )
                await retry(async () =>
                    expect(
                        await driver.page.evaluate(
                            () => document.querySelectorAll('.git-commit-node__oid')[2].textContent
                        )
                    ).toEqual('c13558c')
                )
            })

            // TODO(slimsag:discussions): temporarily disabled because the discussions feature flag removes this component.
            /*
            it('navigates when clicking on a row', async () => {
                await driver.page.goto(baseURL + '/github.com/sourcegraph/jsonrpc2@c6c7b9aa99fb76ee5460ccd3912ba35d419d493d')
                await enableOrAddRepositoryIfNeeded()
                // click on directory
                await driver.page.waitForSelector('.tree-entry', { visible: true })
                await driver.page.click('.tree-entry')
                await assertWindowLocation(
                    '/github.com/sourcegraph/jsonrpc2@c6c7b9aa99fb76ee5460ccd3912ba35d419d493d/-/tree/websocket'
                )
            })
            */
        })

        describe('rev resolution', () => {
            test('shows clone in progress interstitial page', async () => {
                await driver.page.goto(baseURL + '/github.com/sourcegraphtest/AlwaysCloningTest')
                await driver.page.waitForSelector('.hero-page__subtitle', { visible: true })
                await retry(async () =>
                    expect(
                        await driver.page.evaluate(() => document.querySelector('.hero-page__subtitle')!.textContent)
                    ).toEqual('Cloning in progress')
                )
            })

            test('resolves default branch when unspecified', async () => {
                await driver.page.goto(baseURL + '/github.com/sourcegraph/go-diff/-/blob/diff/diff.go')
                await driver.page.waitForSelector('#repo-rev-popover', { visible: true })
                await retry(async () => {
                    expect(
                        await driver.page.evaluate(() => document.querySelector('.e2e-revision')!.textContent!.trim())
                    ).toEqual('master')
                })
                // Verify file contents are loaded.
                await driver.page.waitForSelector(blobTableSelector)
            })

            test('updates rev with switcher', async () => {
                await driver.page.goto(baseURL + '/github.com/sourcegraph/checkup/-/blob/s3.go')
                // Open rev switcher
                await driver.page.waitForSelector('#repo-rev-popover', { visible: true })
                await driver.page.click('#repo-rev-popover')
                // Click "Tags" tab
                await driver.page.click('.revisions-popover .tab-bar__tab:nth-child(2)')
                await driver.page.waitForSelector('a.git-ref-node[href*="0.1.0"]', { visible: true })
                await driver.page.click('a.git-ref-node[href*="0.1.0"]')
                await driver.assertWindowLocation('/github.com/sourcegraph/checkup@v0.1.0/-/blob/s3.go')
            })
        })

        describe('hovers', () => {
            describe(`Blob`, () => {
                test('gets displayed and updates URL when clicking on a token', async () => {
                    await driver.page.goto(
                        baseURL + '/github.com/gorilla/mux@15a353a636720571d19e37b34a14499c3afa9991/-/blob/mux.go'
                    )
                    await driver.page.waitForSelector(blobTableSelector)
                    await clickToken(24, 5)
                    await driver.assertWindowLocation(
                        '/github.com/gorilla/mux@15a353a636720571d19e37b34a14499c3afa9991/-/blob/mux.go#L24:19'
                    )
                    await getHoverContents() // verify there is a hover
                    await percySnapshot(driver.page, 'Code intel hover tooltip')
                })

                test('gets displayed when navigating to a URL with a token position', async () => {
                    await driver.page.goto(
                        baseURL +
                            '/github.com/gorilla/mux@15a353a636720571d19e37b34a14499c3afa9991/-/blob/mux.go#L151:23'
                    )
                    await assertHoverContentContains(
                        `ErrMethodMismatch is returned when the method in the request does not match`
                    )
                })

                describe('jump to definition', () => {
                    test('noops when on the definition', async () => {
                        await driver.page.goto(
                            baseURL +
                                '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/parse.go#L29:6'
                        )
                        await clickHoverJ2D()
                        await driver.assertWindowLocation(
                            '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/parse.go#L29:6'
                        )
                    })

                    test('does navigation (same repo, same file)', async () => {
                        await driver.page.goto(
                            baseURL +
                                '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/parse.go#L25:10'
                        )
                        await clickHoverJ2D()
                        return await driver.assertWindowLocation(
                            '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/parse.go#L29:6'
                        )
                    })

                    test('does navigation (same repo, different file)', async () => {
                        await driver.page.goto(
                            baseURL +
                                '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/print.go#L13:31'
                        )
                        await clickHoverJ2D()
                        await driver.assertWindowLocation(
                            '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/diff.pb.go#L38:6'
                        )
                        // Verify file tree is highlighting the new path.
                        return await driver.page.waitForSelector(
                            '.tree__row--active [data-tree-path="diff/diff.pb.go"]',
                            {
                                visible: true,
                            }
                        )
                    })

                    // basic code intel doesn't support cross-repo jump-to-definition yet.
                    test.skip('does navigation (external repo)', async () => {
                        await driver.page.goto(
                            baseURL +
                                '/github.com/sourcegraph/vcsstore@267289226b15e5b03adedc9746317455be96e44c/-/blob/server/diff.go#L27:30'
                        )
                        await clickHoverJ2D()
                        await driver.assertWindowLocation(
                            '/github.com/sourcegraph/go-vcs@aa7c38442c17a3387b8a21f566788d8555afedd0/-/blob/vcs/repository.go#L103:6'
                        )
                    })
                })

                describe('find references', () => {
                    test('opens widget and fetches local references', async (): Promise<void> => {
                        jest.setTimeout(120000)

                        await driver.page.goto(
                            baseURL +
                                '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/parse.go#L29:6'
                        )
                        await clickHoverFindRefs()
                        await driver.assertWindowLocation(
                            '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/parse.go#L29:6&tab=references'
                        )

                        await driver.assertNonemptyLocalRefs()

                        // verify the appropriate # of references are fetched
                        await driver.page.waitForSelector('.panel__tabs-content .file-match-children', {
                            visible: true,
                        })
                        await retry(async () =>
                            expect(
                                await driver.page.evaluate(
                                    () =>
                                        document.querySelectorAll('.panel__tabs-content .file-match-children__item')
                                            .length
                                )
                            ).toEqual(
                                // Basic code intel finds 8 references with some overlapping context, resulting in 4 hunks.
                                4
                            )
                        )

                        // verify all the matches highlight a `MultiFileDiffReader` token
                        await driver.assertAllHighlightedTokens('MultiFileDiffReader')
                    })

                    // TODO unskip this once basic-code-intel looks for external
                    // references even when local references are found.
                    test.skip('opens widget and fetches external references', async () => {
                        await driver.page.goto(
                            baseURL +
                                '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/parse.go#L32:16&tab=references'
                        )

                        // verify some external refs are fetched (we cannot assert how many, but we can check that the matched results
                        // look like they're for the appropriate token)
                        await driver.assertNonemptyExternalRefs()

                        // verify all the matches highlight a `Reader` token
                        await driver.assertAllHighlightedTokens('Reader')
                    })
                })
            })
        })

        describe.skip('godoc.org "Uses" links', () => {
            test('resolves standard library function', async () => {
                // https://godoc.org/bytes#Compare
                await driver.page.goto(baseURL + '/-/godoc/refs?def=Compare&pkg=bytes&repo=')
                await driver.assertWindowLocationPrefix('/github.com/golang/go/-/blob/src/bytes/bytes_decl.go')
                await driver.assertStickyHighlightedToken('Compare')
                await driver.assertNonemptyLocalRefs()
                await driver.assertAllHighlightedTokens('Compare')
            })

            test('resolves standard library function (from stdlib repo)', async () => {
                // https://godoc.org/github.com/golang/go/src/bytes#Compare
                await driver.page.goto(
                    baseURL +
                        '/-/godoc/refs?def=Compare&pkg=github.com%2Fgolang%2Fgo%2Fsrc%2Fbytes&repo=github.com%2Fgolang%2Fgo'
                )
                await driver.assertWindowLocationPrefix('/github.com/golang/go/-/blob/src/bytes/bytes_decl.go')
                await driver.assertStickyHighlightedToken('Compare')
                await driver.assertNonemptyLocalRefs()
                await driver.assertAllHighlightedTokens('Compare')
            })

            test('resolves external package function (from gorilla/mux)', async () => {
                // https://godoc.org/github.com/gorilla/mux#Router
                await driver.page.goto(
                    baseURL + '/-/godoc/refs?def=Router&pkg=github.com%2Fgorilla%2Fmux&repo=github.com%2Fgorilla%2Fmux'
                )
                await driver.assertWindowLocationPrefix('/github.com/gorilla/mux/-/blob/mux.go')
                await driver.assertStickyHighlightedToken('Router')
                await driver.assertNonemptyLocalRefs()
                await driver.assertAllHighlightedTokens('Router')
            })
        })

        describe('external code host links', () => {
            test('on repo navbar ("View on GitHub")', async () => {
                await driver.page.goto(
                    baseURL +
                        '/github.com/sourcegraph/go-diff@3f415a150aec0685cb81b73cc201e762e075006d/-/blob/diff/parse.go#L19',
                    { waitUntil: 'domcontentloaded' }
                )
                await driver.page.waitForSelector('.nav-link[href*="https://github"]', { visible: true })
                await retry(async () =>
                    expect(
                        await driver.page.evaluate(
                            () =>
                                (document.querySelector('.nav-link[href*="https://github"]') as HTMLAnchorElement).href
                        )
                    ).toEqual(
                        'https://github.com/sourcegraph/go-diff/blob/3f415a150aec0685cb81b73cc201e762e075006d/diff/parse.go#L19'
                    )
                )
            })
        })
    })

    describe('Search component', () => {
        test('can execute search with search operators', async () => {
            await driver.page.goto(baseURL + '/github.com/sourcegraph/go-diff')

            const operators: { [key: string]: string } = {
                repo: '^github.com/sourcegraph/go-diff$',
                count: '1000',
                type: 'file',
                file: '.go',
                '-file': '.md',
            }

            const operatorsQuery = Object.keys(operators)
                .map(op => `${op}:${operators[op]}`)
                .join('+')

            await driver.page.goto(`${baseURL}/search?q=diff+${operatorsQuery}`)
            await driver.page.waitForSelector('.e2e-search-results-stats', { visible: true })
            await retry(async () => {
                const label = await driver.page.evaluate(
                    () => document.querySelector('.e2e-search-results-stats')!.textContent || ''
                )
                expect(label.includes('results')).toEqual(true)
            })
            await driver.page.waitForSelector('.e2e-file-match-children-item', { visible: true })
        })

        test('renders results for sourcegraph/go-diff (no search group)', async () => {
            await driver.page.goto(baseURL + '/github.com/sourcegraph/go-diff')
            await driver.page.goto(
                baseURL + '/search?q=diff+repo:sourcegraph/go-diff%403f415a150aec0685cb81b73cc201e762e075006d+type:file'
            )
            await driver.page.waitForSelector('.e2e-search-results-stats', { visible: true })
            await retry(async () => {
                const label = await driver.page.evaluate(
                    () => document.querySelector('.e2e-search-results-stats')!.textContent || ''
                )
                expect(label.includes('results')).toEqual(true)
            })

            const firstFileMatchHref = await driver.page.$eval(
                '.e2e-file-match-children-item',
                a => (a as HTMLAnchorElement).href
            )

            // navigate to result on click
            await driver.page.click('.e2e-file-match-children-item')

            await retry(async () => {
                expect(await driver.page.evaluate(() => window.location.href)).toEqual(firstFileMatchHref)
            })
        })

        test('accepts query for sourcegraph/jsonrpc2', async () => {
            await driver.page.goto(baseURL + '/search')

            // Update the input value
            await driver.page.waitForSelector('.e2e-query-input', { visible: true })
            await driver.page.keyboard.type('test repo:sourcegraph/jsonrpc2@c6c7b9aa99fb76ee5460ccd3912ba35d419d493d')

            // TODO: test search scopes

            // Submit the search
            await driver.page.click('.search-button')

            await driver.page.waitForSelector('.e2e-search-results-stats', { visible: true })
            await retry(async () => {
                const label = await driver.page.evaluate(
                    () => document.querySelector('.e2e-search-results-stats')!.textContent || ''
                )
                const match = /(\d+) results?/.exec(label)
                if (!match) {
                    throw new Error(
                        `.e2e-search-results-stats textContent did not match regex '(\d+) results': '${label}'`
                    )
                }
                const numberOfResults = parseInt(match[1], 10)
                expect(numberOfResults).toBeGreaterThan(0)
            })
        })
    })
})
