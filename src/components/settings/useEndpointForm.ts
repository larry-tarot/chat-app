import { useState } from 'react'
import { ApiError, verifyApiKey } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { useTranslate } from '../../i18n/index.js'
import {
  normalizeEndpointUrl,
  resetEndpoint,
  saveEndpoint,
  useSettings,
  type Protocol,
} from '../../services/settings.js'

/** 保存结果：成功后可能是「连接正常」，也可能「已保存但校验未通过」，两者都要如实展示 */
type Status = { tone: 'ok' | 'error'; text: string } | null

/**
 * 端点表单：草稿态与已保存态分离，点「保存」才落库。
 * 地址非法时不写任何键（旧配置保留）；合法则立即生效，再用当前 Key 探一次。
 */
export const useEndpointForm = () => {
  const t = useTranslate()
  const endpoint = useSettings((state) => state.endpoint)
  const [protocol, setProtocol] = useState<Protocol>(endpoint.protocol)
  const [baseUrl, setBaseUrl] = useState(endpoint.baseUrl)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  /** 校验失败的可读原因：401 / 网络（CORS）单独给文案，其余透传服务端消息 */
  const describeFailure = (error: unknown): string => {
    const condition = classifyApiError(error)
    if (condition === 'unauthorized') {
      return t('settingsEndpointRejected')
    }
    if (condition === 'network') {
      return t('settingsEndpointUnreachable')
    }
    if (error instanceof ApiError && error.localMessage) {
      return t(error.localMessage.key, error.localMessage.params)
    }
    return error instanceof Error ? error.message : String(error)
  }

  const save = async () => {
    if (busy) {
      return
    }
    // 先规范化再落库：ftp:// 之类会在这里被判非法，旧值原样保留
    const normalized = normalizeEndpointUrl(baseUrl)
    if (normalized === null || !saveEndpoint({ protocol, baseUrl: normalized })) {
      setStatus({ tone: 'error', text: t('settingsEndpointInvalid') })
      return
    }
    setBaseUrl(normalized)
    setStatus(null)
    const apiKey = useSettings.getState().apiKey
    if (!apiKey) {
      // 没有 Key 就探不了：只能如实说「存下了、还没验」，不能报「连接正常」
      setStatus({ tone: 'ok', text: t('settingsEndpointSavedUnverified') })
      return
    }
    setBusy(true)
    try {
      await verifyApiKey(apiKey)
      setStatus({ tone: 'ok', text: t('settingsEndpointSaved') })
    } catch (error) {
      // 配置已写入（用户可能先配好再修网关），失败只作为状态提示，不回滚
      setStatus({
        tone: 'error',
        text: t('settingsEndpointCheckFailed', { message: describeFailure(error) }),
      })
    } finally {
      setBusy(false)
    }
  }

  /** 恢复构建期默认端点，同时把草稿拉回真实值 */
  const reset = () => {
    resetEndpoint()
    const next = useSettings.getState().endpoint
    setProtocol(next.protocol)
    setBaseUrl(next.baseUrl)
    setStatus(null)
  }

  return {
    protocol,
    baseUrl,
    busy,
    status,
    save,
    reset,
    setProtocol: (value: Protocol) => {
      setProtocol(value)
      setStatus(null)
    },
    setBaseUrl: (value: string) => {
      setBaseUrl(value)
      setStatus(null)
    },
    /** 输入框失焦时把可解析的地址回填成规范化形式（例如 gw.example.com → https://gw.example.com） */
    commitBaseUrl: () => {
      const normalized = normalizeEndpointUrl(baseUrl)
      if (normalized !== null) {
        setBaseUrl(normalized)
      }
    },
  }
}

export type EndpointEditor = ReturnType<typeof useEndpointForm>
