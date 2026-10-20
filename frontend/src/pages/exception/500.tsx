import Exception from '@/components/exception'

export default function ServerErrorPage() {
  return <Exception status="500" title="500" subTitle="服务异常，请稍后重试" />
}
