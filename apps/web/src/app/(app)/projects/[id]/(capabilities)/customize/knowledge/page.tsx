'use client';

import { useParams } from 'next/navigation';

import { KnowledgePage } from '@/features/workspace/capabilities/knowledge/knowledge-page';

/**
 * /projects/[id]/customize/knowledge — the documents in `.kortix/knowledge/`
 * that agents read. See `features/workspace/capabilities/knowledge/knowledge-page.tsx`.
 */
export default function ProjectKnowledgePage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <KnowledgePage projectId={projectId} />
    </div>
  );
}
