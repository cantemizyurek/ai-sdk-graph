'use client'

import { useState, useCallback, useMemo } from 'react'
import { useChat, type UseChatOptions, type UseChatHelpers } from '@ai-sdk/react'
import {
    DefaultChatTransport,
    type UIMessage,
    type ChatInit,
    type HttpChatTransportInitOptions,
} from 'ai'
import { stripGraphDataParts } from './utils'

export interface UseGraphChatOptions<
    State extends Record<string, unknown>,
    UI_MESSAGE extends UIMessage = UIMessage
> extends Omit<ChatInit<UI_MESSAGE>, 'transport' | 'onData'> {
    onStateChange?: (state: State) => void
    onNodeStart?: (nodeId: string) => void
    onNodeEnd?: (nodeId: string) => void
    onNodeSuspense?: (nodeId: string, data: unknown) => void
    transportOptions?: Omit<HttpChatTransportInitOptions<UI_MESSAGE>, 'prepareSendMessagesRequest'>
    prepareSendMessagesRequest?: HttpChatTransportInitOptions<UI_MESSAGE>['prepareSendMessagesRequest']
    experimental_throttle?: number
    resume?: boolean
}

export interface UseGraphChatHelpers<
    State extends Record<string, unknown>,
    UI_MESSAGE extends UIMessage = UIMessage
> extends UseChatHelpers<UI_MESSAGE> {
    state: State | null
    activeNodes: string[]
}

export function useGraphChat<
    State extends Record<string, unknown>,
    UI_MESSAGE extends UIMessage = UIMessage
>(
    options: UseGraphChatOptions<State, UI_MESSAGE> = {}
): UseGraphChatHelpers<State, UI_MESSAGE> {
    const {
        onStateChange,
        onNodeStart,
        onNodeEnd,
        onNodeSuspense,
        transportOptions,
        prepareSendMessagesRequest: customPrepareRequest,
        ...chatInitOptions
    } = options

    const [graphState, setGraphState] = useState<State | null>(null)
    const [activeNodes, setActiveNodes] = useState<string[]>([])

    const handleData = useCallback(
        (dataPart: { type: string; data: unknown }) => {
            if (dataPart.type === 'data-state') {
                const newState = dataPart.data as State
                setGraphState(newState)
                onStateChange?.(newState)
            } else if (dataPart.type === 'data-node-start') {
                const nodeId = dataPart.data as string
                setActiveNodes((prev) => [...prev, nodeId])
                onNodeStart?.(nodeId)
            } else if (dataPart.type === 'data-node-end') {
                const nodeId = dataPart.data as string
                setActiveNodes((prev) => prev.filter(node => node !== nodeId))
                onNodeEnd?.(nodeId)
            } else if (dataPart.type === 'data-node-suspense') {
                const { nodeId, data } = dataPart.data as { nodeId: string; data: unknown }
                onNodeSuspense?.(nodeId, data)
                setActiveNodes([])
            }
        },
        [onStateChange, onNodeStart, onNodeEnd, onNodeSuspense]
    )

    const transport = useMemo(() => {
        return new DefaultChatTransport<UI_MESSAGE>({
            ...transportOptions,
            prepareSendMessagesRequest: (requestOptions) => {
                const strippedMessages = stripGraphDataParts(requestOptions.messages)

                if (customPrepareRequest) {
                    return customPrepareRequest({
                        ...requestOptions,
                        messages: strippedMessages,
                    })
                }

                return {
                    body: {
                        id: requestOptions.id,
                        messages: strippedMessages,
                        trigger: requestOptions.trigger,
                    },
                }
            },
        })
    }, [transportOptions, customPrepareRequest])

    const chatHelpers = useChat<UI_MESSAGE>({
        ...chatInitOptions,
        transport,
        onData: handleData,
    } as UseChatOptions<UI_MESSAGE>)

    return {
        ...chatHelpers,
        state: graphState,
        activeNodes,
    }
}
