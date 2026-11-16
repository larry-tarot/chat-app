import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'

/** `useTranslate()` 返回的翻译函数形状（普通函数里调用时用这个签名） */
export type Translate = (key: TranslationKey, params?: TranslationParams) => string

/**
 * 网络类失败（`ApiError` 无 status，含被 CORS 拦下的请求）的统一措辞。
 *
 * 为什么必须只有一处：同一个条件原先在 `useApiKeyForm` 与 `useEndpointForm` 各写了一句，
 * 一处说「网络异常，请检查你的网络状况」（把责任推给用户），一处说「请确认网关放行 CORS」
 * （指向真正的原因）。措辞分叉后，用户按表单的先后顺序会得到互相矛盾的排查方向。
 *
 * 判定还要看端点来源：用构建期默认地址时，出网失败就是用户自己的网络；
 * 只有自定义端点才可能是网关没放行 CORS 或地址写错。
 */
export const networkFailureText = (t: Translate): string =>
  useSettings.getState().endpoint.source === 'override'
    ? t('settingsEndpointUnreachable')
    : t('commonNetworkErrorToast')
