import { defineConfig, presetWind3 } from 'unocss'

export default defineConfig({
  rules: [
    // 登录背景
    ['bg-login', { background: 'linear-gradient(60deg, rgba(84, 58, 183, 1) 0%, rgba(0, 172, 193, 1) 100%)' }],
    ['bg-login-dark', { background: 'linear-gradient(60deg, rgba(54, 38, 123, 1) 0%, rgba(0, 112, 123, 1) 100%)' }],
    [/^align-\[([+-]?\d.+)\]$/, ([_, num]) => ({ 'vertical-align': num })],
    ['text-optimizeLegibility', { 'text-rendering': 'optimizeLegibility' }],
  ],
  shortcuts: {
    // 主题
    'text-theme': 'text-dark-800',
    'text-theme-dark': 'text-light-300',
    'bg-theme-layout': 'bg-white',
    'bg-theme-layout-dark': 'bg-dark-800',
    'bg-theme-content': 'bg-light-300',
    'bg-theme-content-dark': 'bg-black',
    // 图标
    'icon-wrapper': 'inline-block leading-0 h-1em w-1em text-inherit font-not-italic normal-case text-center align-[-0.2em] text-optimizeLegibility antialiased [&_svg]:inline-block [&_svg]:align-baseline',
    // 登录背景波浪
    'bg-login-waves': 'relative w-full h-20vh mb-[-7px] min-h-100px',
    'bg-login-wave-1': 'animate-wave-move animate-delay-[-2s] animate-duration-[7s]',
    'bg-login-wave-2': 'animate-wave-move animate-delay-[-3s] animate-duration-[10s]',
    'bg-login-wave-3': 'animate-wave-move animate-delay-[-4s] animate-duration-[13s]',
    'bg-login-wave-4': 'animate-wave-move animate-delay-[-5s] animate-duration-[20s]',
  },
  theme: {
    animation: {
      keyframes: {
        'wave-move': '{ 0% {transform: translate3d(-90px, 0, 0); } 100% {transform: translate3d(85px, 0, 0); }}',
      },
      durations: {
        'wave-move': '25s',
      },
      timingFns: {
        'wave-move': 'cubic-bezier(0.55, 0.5, 0.45, 0.5)',
      },
      counts: {
        'wave-move': 'infinite',
      },
    },
  },
  safelist: [
    'bg-login-waves',
    'bg-login-wave-1',
    'bg-login-wave-2',
    'bg-login-wave-3',
    'bg-login-wave-4',
    'text-theme',
    'text-theme-dark',
    'bg-theme-layout',
    'bg-theme-layout-dark',
    'bg-theme-content',
    'bg-theme-content-dark',
  ],
  presets: [
    presetWind3(),
  ],
})
