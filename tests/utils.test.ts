import { test, expect, describe, mock } from 'bun:test'
import { consumeAndMergeStream } from '../src/utils'
import type { UIMessage } from 'ai'

describe('consumeAndMergeStream', () => {
    test('returns a promise that resolves with messages when onFinish is called', async () => {
        const mockMessages: UIMessage[] = [
            { id: '1', role: 'assistant', parts: [{ type: 'text', text: 'Hello' }] }
        ]

        let capturedOnFinish: ((args: { messages: UIMessage[] }) => void) | undefined

        const mockStream = {
            toUIMessageStream: mock((options: { onFinish?: (args: { messages: UIMessage[] }) => void }) => {
                capturedOnFinish = options.onFinish
                return new ReadableStream()
            })
        }

        const mockWriter = {
            merge: mock(() => { })
        }

        const messagesPromise = consumeAndMergeStream(mockStream as any, mockWriter as any)

        // Simulate the stream finishing
        capturedOnFinish!({ messages: mockMessages })

        const result = await messagesPromise

        expect(result).toEqual(mockMessages)
        expect(mockWriter.merge).toHaveBeenCalledTimes(1)
        expect(mockStream.toUIMessageStream).toHaveBeenCalledTimes(1)
    })

    test('passes options to toUIMessageStream', async () => {
        const mockMessages: UIMessage[] = []
        let capturedOnFinish: ((args: { messages: UIMessage[] }) => void) | undefined
        let capturedOptions: any

        const mockStream = {
            toUIMessageStream: mock((options: any) => {
                capturedOptions = options
                capturedOnFinish = options.onFinish
                return new ReadableStream()
            })
        }

        const mockWriter = {
            merge: mock(() => { })
        }

        const customOptions = {
            sendReasoning: true,
            sendSources: false
        }

        const messagesPromise = consumeAndMergeStream(mockStream as any, mockWriter as any, customOptions)

        capturedOnFinish!({ messages: mockMessages })
        await messagesPromise

        expect(capturedOptions.sendReasoning).toBe(true)
        expect(capturedOptions.sendSources).toBe(false)
        expect(typeof capturedOptions.onFinish).toBe('function')
    })

    test('calls writer.merge with the stream from toUIMessageStream', async () => {
        const mockMessages: UIMessage[] = []
        let capturedOnFinish: ((args: { messages: UIMessage[] }) => void) | undefined
        const mockReadableStream = new ReadableStream()

        const mockStream = {
            toUIMessageStream: mock((options: any) => {
                capturedOnFinish = options.onFinish
                return mockReadableStream
            })
        }

        let mergedStream: ReadableStream | undefined
        const mockWriter = {
            merge: mock((stream: ReadableStream) => {
                mergedStream = stream
            })
        }

        const messagesPromise = consumeAndMergeStream(mockStream as any, mockWriter as any)

        capturedOnFinish!({ messages: mockMessages })
        await messagesPromise

        expect(mergedStream).toBe(mockReadableStream)
    })

    test('handles multiple messages correctly', async () => {
        const mockMessages: UIMessage[] = [
            { id: '1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
            { id: '2', role: 'assistant', parts: [{ type: 'text', text: 'Hello!' }] },
            { id: '3', role: 'user', parts: [{ type: 'text', text: 'How are you?' }] },
            { id: '4', role: 'assistant', parts: [{ type: 'text', text: 'I am fine, thank you!' }] }
        ]

        let capturedOnFinish: ((args: { messages: UIMessage[] }) => void) | undefined

        const mockStream = {
            toUIMessageStream: mock((options: any) => {
                capturedOnFinish = options.onFinish
                return new ReadableStream()
            })
        }

        const mockWriter = {
            merge: mock(() => { })
        }

        const messagesPromise = consumeAndMergeStream(mockStream as any, mockWriter as any)

        capturedOnFinish!({ messages: mockMessages })

        const result = await messagesPromise

        expect(result).toEqual(mockMessages)
        expect(result.length).toBe(4)
    })

    test('resolves with empty array when no messages', async () => {
        const mockMessages: UIMessage[] = []
        let capturedOnFinish: ((args: { messages: UIMessage[] }) => void) | undefined

        const mockStream = {
            toUIMessageStream: mock((options: any) => {
                capturedOnFinish = options.onFinish
                return new ReadableStream()
            })
        }

        const mockWriter = {
            merge: mock(() => { })
        }

        const messagesPromise = consumeAndMergeStream(mockStream as any, mockWriter as any)

        capturedOnFinish!({ messages: mockMessages })

        const result = await messagesPromise

        expect(result).toEqual([])
        expect(result.length).toBe(0)
    })

    test('does not resolve until onFinish is called', async () => {
        let capturedOnFinish: ((args: { messages: UIMessage[] }) => void) | undefined
        let resolved = false

        const mockStream = {
            toUIMessageStream: mock((options: any) => {
                capturedOnFinish = options.onFinish
                return new ReadableStream()
            })
        }

        const mockWriter = {
            merge: mock(() => { })
        }

        const messagesPromise = consumeAndMergeStream(mockStream as any, mockWriter as any)
        messagesPromise.then(() => {
            resolved = true
        })

        // Give some time for the promise to potentially resolve incorrectly
        await new Promise(resolve => setTimeout(resolve, 10))
        expect(resolved).toBe(false)

        // Now call onFinish
        capturedOnFinish!({ messages: [] })
        await messagesPromise

        expect(resolved).toBe(true)
    })
})
