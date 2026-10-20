import type { ResultProps } from 'antd'

import { Button, Result } from 'antd'
import { useNavigate } from 'react-router-dom'

export default function Exception({ status, title, subTitle }: { status: ResultProps['status'], title: string, subTitle: string }) {
  const navigate = useNavigate()
  return (
    <div className="h-screen flex items-center justify-center">
      <Result
        status={status}
        title={title}
        subTitle={subTitle}
        extra={<Button type="primary" onClick={() => navigate('/')}>返回首页</Button>}
      />
    </div>
  )
}
