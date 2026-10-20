import type { IconProps as IconifyProps } from '@iconify/react'

import { Icon as Iconify } from '@iconify/react'
import clsx from 'clsx'
import { useEffect, useState } from 'react'

interface IconProps extends IconifyProps {
  className?: string
}

export default function Icon({ icon, className, ...restProps }: IconProps) {
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const handleIconChange = async () => {
      setLoading(true)
      await Promise.resolve()
      setLoading(false)
    }

    handleIconChange()
  }, [icon])

  if (loading) {
    return <span className={clsx('icon-wrapper', className)} />
  }

  return (
    <span className={clsx('icon-wrapper', className)}>
      <Iconify icon={icon} {...restProps} />
    </span>
  )
}
