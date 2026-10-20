export { setupIconifyOffline } from './iconify'

export function hideLoading() {
  const loading = document.querySelector('#Loading')
  loading?.classList.add('is-hide')
  setTimeout(() => {
    loading?.remove()
  }, 300)
}

export function setupLoading() {
  const loading = document.querySelector('#Loading')
  if (loading) {
    loading.querySelector('.preload__logo')!.innerHTML = '<img src="/logo.svg" alt="logo">'
    loading.querySelector('.preload__name')!.innerHTML = import.meta.env.VITE_APP_TITLE
    loading.querySelector('.preload__text')!.innerHTML = '加载中…'
  }
}
