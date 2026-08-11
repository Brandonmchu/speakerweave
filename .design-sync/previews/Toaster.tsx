import { useEffect } from 'react'
import { Toaster, toast } from 'dais-web'

export const Default = () => {
  useEffect(() => {
    toast({
      title: 'Schedule published',
      description: '62 sessions are now live on the public DevConf agenda.',
    })
  }, [])

  return (
    <div className="pb-40">
      <Toaster />
    </div>
  )
}

export const Variants = () => {
  useEffect(() => {
    toast({
      variant: 'destructive',
      title: 'Could not email 2 speakers',
      description: 'Bounced addresses are listed on the Speakers tab.',
    })
    toast({
      variant: 'success',
      title: 'Reviewer assignments saved',
      description: '14 submissions now have a second reviewer.',
    })
  }, [])

  return (
    <div className="pb-40">
      <Toaster />
    </div>
  )
}
