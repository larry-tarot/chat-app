import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import type { Protocol } from '../../services/settings.js'
import { Select } from '../base/Select.js'
import styles from './Settings.module.css'
import { useEndpointForm } from './useEndpointForm.js'

/**
 * 服务商分区：协议 + 端点地址 + 恢复默认。
 * 只负责采集与展示；规范化、落库与校验在 `useEndpointForm` / `services/settings.ts` 里。
 */
export const EndpointSettings = ({ onConfigureApiKey }: { onConfigureApiKey: () => void }) => {
  const t = useTranslate()
  const form = useEndpointForm()
  const protocolOptions: { value: Protocol; label: string }[] = [
    { value: 'anthropic-messages', label: t('settingsProtocolAnthropic') },
    { value: 'openai-chat', label: t('settingsProtocolOpenai') },
  ]

  return (
    <>
      <div className={styles.cell}>
        <div className={styles.row}>
          <div className={styles.text}>
            <div className={styles.label}>{t('settingsProtocol')}</div>
            <div className={styles.description}>{t('settingsProtocolDescription')}</div>
          </div>
          <Select
            ariaLabel={t('settingsProtocol')}
            value={form.protocol}
            options={protocolOptions}
            onChange={form.setProtocol}
          />
        </div>
      </div>
      <div className={clsx(styles.cell, styles.endpointCell)}>
        <div className={styles.row}>
          <div className={styles.text}>
            <div className={styles.label}>{t('settingsEndpoint')}</div>
            <div
              className={clsx(
                styles.description,
                form.status?.tone === 'error' && styles.error,
                form.status?.tone === 'ok' && styles.success
              )}
              role="status"
              aria-live="polite"
            >
              {form.status ? form.status.text : t('settingsEndpointDescription')}
            </div>
          </div>
          <div className={styles.endpointAction}>
            <div className={clsx(styles.apiKeyInput, styles.endpointInput)}>
              <input
                type="text"
                inputMode="url"
                aria-label={t('settingsEndpoint')}
                placeholder={t('settingsEndpointPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                value={form.baseUrl}
                onChange={(event) => form.setBaseUrl(event.target.value)}
                onBlur={form.commitBaseUrl}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    void form.save()
                  }
                }}
              />
              <span className={styles.divider} />
              <button
                type="button"
                className={styles.confirm}
                disabled={form.busy}
                // 保持输入框焦点，避免先触发失焦回填再点击
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void form.save()}
              >
                {form.busy ? t('settingsEndpointVerifying') : t('settingsEndpointSave')}
              </button>
            </div>
            <button
              type="button"
              className={clsx(styles.confirm, styles.endpointReset)}
              disabled={form.busy}
              onClick={form.reset}
            >
              {t('settingsEndpointReset')}
            </button>
          </div>
        </div>
      </div>
      {/* Key 不在这个分区：第一次配网关的人会去「通用设置」里翻（实测踩过），这里直接给入口 */}
      <div className={styles.providerHint}>
        <span>{t('settingsEndpointApiKeyHint')}</span>
        <button type="button" className={styles.hintLink} onClick={onConfigureApiKey}>
          {t('settingsEndpointApiKeyGo')}
        </button>
      </div>
    </>
  )
}
