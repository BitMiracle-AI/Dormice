import { cn } from "@/lib/utils"
import { HugeiconsIcon, type HugeiconsProps } from "@hugeicons/react"
import { Loading03Icon } from "@hugeicons/core-free-icons"

// Registry ships React.ComponentProps<"svg"> here, whose `strokeWidth:
// string | number` conflicts with HugeiconsIcon's `number` (known preset
// bug, same fix as clawsgo). Re-apply after `shadcn apply` rewrites.
function Spinner({ className, ...props }: Omit<HugeiconsProps, "icon">) {
  return (
    <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} data-slot="spinner" role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} {...props} />
  )
}

export { Spinner }
