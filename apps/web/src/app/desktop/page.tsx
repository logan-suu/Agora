import { notFound } from 'next/navigation';
import { DesktopPreview } from './preview';

export const dynamic = 'force-dynamic';

export default function DesktopPage() {
  if (process.env.AGORA_DESKTOP_PREVIEW !== '1') notFound();
  return <DesktopPreview />;
}
