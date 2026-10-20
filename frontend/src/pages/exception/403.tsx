import Exception from '@/components/exception'

export default function ForbiddenPage() {
  return <Exception status="403" title="403" subTitle="你没有访问该页面的权限" />
}
