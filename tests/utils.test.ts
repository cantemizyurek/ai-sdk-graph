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

    test('rejects when onError is called', async () => {
        let capturedOnError: ((error: unknown) => string) | undefined

        const mockStream = {
            toUIMessageStream: mock((options: any) => {
                capturedOnError = options.onError
                return new ReadableStream()
            })
        }

        const mockWriter = {
            merge: mock(() => { })
        }

        const messagesPromise = consumeAndMergeStream(mockStream as any, mockWriter as any)

        const testError = new Error('Stream error')
        capturedOnError!(testError)

        await expect(messagesPromise).rejects.toThrow('Stream error')
    })

    test('onError returns error message string', async () => {
        let capturedOnError: ((error: unknown) => string) | undefined

        const mockStream = {
            toUIMessageStream: mock((options: any) => {
                capturedOnError = options.onError
                return new ReadableStream()
            })
        }

        const mockWriter = {
            merge: mock(() => { })
        }

        // Catch the rejection to prevent unhandled promise rejection
        const messagesPromise = consumeAndMergeStream(mockStream as any, mockWriter as any)
        messagesPromise.catch(() => { })

        const testError = new Error('Custom error message')
        const errorMessage = capturedOnError!(testError)

        expect(errorMessage).toBe('Custom error message')
    })

    test('onError returns default message for non-Error objects', async () => {
        let capturedOnError: ((error: unknown) => string) | undefined

        const mockStream = {
            toUIMessageStream: mock((options: any) => {
                capturedOnError = options.onError
                return new ReadableStream()
            })
        }

        const mockWriter = {
            merge: mock(() => { })
        }

        const messagesPromise = consumeAndMergeStream(mockStream as any, mockWriter as any)
        messagesPromise.catch(() => { })

        const errorMessage = capturedOnError!('string error')

        expect(errorMessage).toBe('An error occurred.')
    })

    test('rejects when toUIMessageStream throws synchronously', async () => {
        const syncError = new Error('Sync error')

        const mockStream = {
            toUIMessageStream: mock(() => {
                throw syncError
            })
        }

        const mockWriter = {
            merge: mock(() => { })
        }

        const messagesPromise = consumeAndMergeStream(mockStream as any, mockWriter as any)

        await expect(messagesPromise).rejects.toThrow('Sync error')
    })

    test('writer.merge is not called when toUIMessageStream throws', async () => {
        const mockStream = {
            toUIMessageStream: mock(() => {
                throw new Error('Sync error')
            })
        }

        const mockWriter = {
            merge: mock(() => { })
        }

        const messagesPromise = consumeAndMergeStream(mockStream as any, mockWriter as any)

        await expect(messagesPromise).rejects.toThrow()
        expect(mockWriter.merge).not.toHaveBeenCalled()
    })

    test('writer.merge is called before onError triggers', async () => {
        let capturedOnError: ((error: unknown) => string) | undefined
        let mergeCalledBeforeError = false

        const mockStream = {
            toUIMessageStream: mock((options: any) => {
                capturedOnError = options.onError
                return new ReadableStream()
            })
        }

        const mockWriter = {
            merge: mock(() => {
                mergeCalledBeforeError = true
            })
        }

        const messagesPromise = consumeAndMergeStream(mockStream as any, mockWriter as any)

        expect(mergeCalledBeforeError).toBe(true)
        expect(mockWriter.merge).toHaveBeenCalledTimes(1)

        capturedOnError!(new Error('test'))
        await expect(messagesPromise).rejects.toThrow()
    })

    test('does not pass user-provided onError or onFinish options', async () => {
        let capturedOptions: any
        let capturedOnFinish: ((args: { messages: UIMessage[] }) => void) | undefined

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

        // Try to pass onFinish and onError in options (should be ignored due to Omit)
        const messagesPromise = consumeAndMergeStream(mockStream as any, mockWriter as any, {
            sendReasoning: true
        } as any)

        capturedOnFinish!({ messages: [] })
        await messagesPromise

        // The internal onFinish and onError should be set, not user-provided ones
        expect(typeof capturedOptions.onFinish).toBe('function')
        expect(typeof capturedOptions.onError).toBe('function')
        expect(capturedOptions.sendReasoning).toBe(true)
    })
})
