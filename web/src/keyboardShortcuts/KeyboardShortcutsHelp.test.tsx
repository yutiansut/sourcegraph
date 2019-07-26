import React from 'react'
import renderer from 'react-test-renderer'
import { Modal } from 'reactstrap'
import { keybindingKeysDescription, KeyboardShortcutsHelp } from './KeyboardShortcutsHelp'

describe('KeyboardShortcutsHelp', () => {
    test('no user account', () => {
        const e = renderer.create(
            <KeyboardShortcutsHelp
                keyboardShortcuts={[
                    {
                        id: 'x',
                        title: 't',
                        keybindings: [{ held: ['Alt'], ordered: ['x'] }],
                    },
                ]}
                keyboardShortcutForShow={{
                    id: 'x',
                    title: 't',
                    keybindings: [{ held: ['Alt'], ordered: ['x'] }],
                }}
            />
        )
        // Modal is hidden by default and uses portal, so we can't easily test its contents. Grab
        // its inner .modal-body and snapshot that instead.
        expect(renderer.create(e.root.findByType(Modal).props.children[1]).toJSON()).toMatchSnapshot()
    })
})

describe('keybindingKeysDescription', () => {
    test('ordered only', () => expect(keybindingKeysDescription({ ordered: ['x'] })).toBe('x'))
    test('held and ordered', () =>
        expect(keybindingKeysDescription({ held: ['Control', 'Alt'], ordered: ['x'] })).toBe('Control+Alt+x'))
})
