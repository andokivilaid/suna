'use client';

import {
  ApiError,
  deleteProjectKnowledgeFile,
  downloadProjectKnowledgeFile,
  listProjectKnowledge,
  type ProjectKnowledge,
  type ProjectKnowledgeFile,
  updateProjectKnowledgeFile,
  uploadProjectKnowledge,
} from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import {
  BooksIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  FileCsvIcon,
  FileDocIcon,
  FileIcon,
  FileImageIcon,
  FileMdIcon,
  FilePdfIcon,
  FilePptIcon,
  FileTextIcon,
  FileXlsIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  TrashIcon,
  UploadSimpleIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type DragEvent, type FormEvent, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';

import {
  checkUploadSelection,
  filterKnowledgeFiles,
  formatKnowledgeBytes,
  knowledgeFileName,
  type UploadSelectionProblem,
} from './knowledge-format';

const LIST_CLASS = 'bg-popover divide-border divide-y overflow-hidden rounded-md border';

const TYPE_ICONS: Record<string, typeof FileIcon> = {
  pdf: FilePdfIcon,
  md: FileMdIcon,
  mdx: FileMdIcon,
  doc: FileDocIcon,
  docx: FileDocIcon,
  odt: FileDocIcon,
  rtf: FileDocIcon,
  xls: FileXlsIcon,
  xlsx: FileXlsIcon,
  ods: FileXlsIcon,
  csv: FileCsvIcon,
  ppt: FilePptIcon,
  pptx: FilePptIcon,
  odp: FilePptIcon,
  png: FileImageIcon,
  jpg: FileImageIcon,
  jpeg: FileImageIcon,
  gif: FileImageIcon,
  webp: FileImageIcon,
  txt: FileTextIcon,
  json: FileTextIcon,
  yaml: FileTextIcon,
  yml: FileTextIcon,
  html: FileTextIcon,
};

function KnowledgeTypeIcon({ type }: { type: string }) {
  const className = 'text-muted-foreground size-5';
  const Icon = TYPE_ICONS[type];
  return Icon ? <Icon className={className} /> : <FileIcon className={className} />;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Let the click start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * /projects/[id]/customize/knowledge — the documents in `.kortix/knowledge/`.
 *
 * Every read and write goes through `@kortix/sdk` (`listProjectKnowledge`,
 * `uploadProjectKnowledge`, …). A write is one commit on the default branch
 * that also regenerates INDEX.md, so after each mutation this page refetches
 * its own list and invalidates the project detail (the Files page tree).
 */
export function KnowledgePage({ projectId }: { projectId: string }) {
  const t = useTranslations('knowledge');
  const queryClient = useQueryClient();
  const accountId = useProjectAccountId(projectId);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_FILE_WRITE, { accountId }).allowed === true;

  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<File[] | null>(null);
  const [editing, setEditing] = useState<ProjectKnowledgeFile | null>(null);
  const [deleting, setDeleting] = useState<ProjectKnowledgeFile | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const knowledgeQuery = useQuery({
    queryKey: qk.project.knowledge(projectId),
    queryFn: () => listProjectKnowledge(projectId),
    ...contract('config'),
    enabled: !!projectId,
  });
  const data = knowledgeQuery.data;
  const files = useMemo(() => data?.files ?? [], [data]);
  const filtered = useMemo(() => filterKnowledgeFiles(files, query), [files, query]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.project.knowledge(projectId) });
    void queryClient.invalidateQueries({ queryKey: qk.project.detail(projectId) });
  };

  const remove = useMutation({
    mutationFn: (file: ProjectKnowledgeFile) => deleteProjectKnowledgeFile(projectId, file.path),
    onSuccess: () => {
      successToast(t('toast.deleted'));
      setDeleting(null);
      refresh();
    },
    onError: (error: Error) => errorToast(error.message),
  });

  const download = useMutation({
    mutationFn: async (file: ProjectKnowledgeFile) => {
      saveBlob(await downloadProjectKnowledgeFile(projectId, file.path), knowledgeFileName(file.path));
    },
    onError: (error: Error, file) =>
      errorToast(t('toast.downloadFailed', { name: knowledgeFileName(file.path) }), {
        description: error.message,
      }),
  });

  const choose = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setPending(Array.from(list));
  };

  const onDragOver = (event: DragEvent) => {
    if (!canWrite || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setDragging(true);
  };
  const onDrop = (event: DragEvent) => {
    if (!canWrite) return;
    event.preventDefault();
    setDragging(false);
    choose(event.dataTransfer.files);
  };

  const forbidden = knowledgeQuery.error instanceof ApiError && knowledgeQuery.error.status === 403;

  const uploadButton = (label: string, variant: 'secondary' | 'outline') =>
    canWrite ? (
      <Button
        size="sm"
        variant={variant}
        className="gap-1.5"
        onClick={() => inputRef.current?.click()}
      >
        <UploadSimpleIcon className="size-4 shrink-0" />
        {label}
      </Button>
    ) : null;

  return (
    <CapabilityPageShell
      title={t('title')}
      description={t('description')}
      action={uploadButton(t('upload'), 'secondary')}
      search={
        files.length > 0 ? (
          <InputGroupSearch>
            <InputGroupSearchIcon>
              <MagnifyingGlassIcon />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              placeholder={t('searchPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              variant="popover"
              size="sm"
            />
            <InputGroupSearchClear onClick={() => setQuery('')} />
          </InputGroupSearch>
        ) : undefined
      }
      filters={
        data ? (
          <p className="text-muted-foreground text-xs" data-testid="knowledge-usage">
            {t('usage', {
              count: data.files.length,
              used: formatKnowledgeBytes(data.total_bytes),
              limit: formatKnowledgeBytes(data.limits.max_total_bytes),
            })}
          </p>
        ) : undefined
      }
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        data-testid="knowledge-file-input"
        onChange={(event) => {
          choose(event.target.files);
          event.target.value = '';
        }}
      />
      <div
        className="space-y-4"
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {canWrite && data ? (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className={cn(
              'bg-popover hover:bg-hover flex w-full flex-col items-center gap-1.5 rounded-md border border-dashed px-4 py-6 text-center transition-colors',
              dragging && 'border-ring bg-active',
            )}
            data-testid="knowledge-dropzone"
          >
            <UploadSimpleIcon className="text-muted-foreground size-5 shrink-0" />
            <span className="text-foreground text-sm font-medium">{t('dropTitle')}</span>
            <span className="text-muted-foreground text-xs">
              {t('dropHint', {
                maxFiles: data.limits.max_upload_files,
                maxFileSize: formatKnowledgeBytes(data.limits.max_file_bytes),
              })}
            </span>
          </button>
        ) : null}

        {knowledgeQuery.isLoading ? (
          <ul className={LIST_CLASS}>
            {[0, 1, 2].map((row) => (
              <li key={row} className="flex items-center gap-3 px-4 py-2.5">
                <Skeleton className="size-9 shrink-0 rounded-sm" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </li>
            ))}
          </ul>
        ) : forbidden ? (
          <ErrorState size="sm" title={t('noAccessTitle')} description={t('noAccessDescription')} />
        ) : knowledgeQuery.isError ? (
          <ErrorState
            size="sm"
            title={t('loadError')}
            description={knowledgeQuery.error instanceof Error ? knowledgeQuery.error.message : undefined}
            action={
              <Button variant="outline" size="sm" onClick={() => knowledgeQuery.refetch()}>
                {t('retry')}
              </Button>
            }
          />
        ) : files.length === 0 ? (
          <EmptyState
            icon={BooksIcon}
            size="sm"
            title={t('emptyTitle')}
            description={t('emptyDescription')}
            action={uploadButton(t('uploadDocuments'), 'outline')}
          />
        ) : filtered.length === 0 ? (
          <p className="text-muted-foreground px-1 text-sm">{t('noMatch', { query: query.trim() })}</p>
        ) : (
          <ul className={LIST_CLASS} data-testid="knowledge-list">
            {filtered.map((file) => (
              <KnowledgeRow
                key={file.path}
                file={file}
                canWrite={canWrite}
                busy={
                  (download.isPending && download.variables?.path === file.path) ||
                  (remove.isPending && remove.variables?.path === file.path)
                }
                onDownload={() => download.mutate(file)}
                onEdit={() => setEditing(file)}
                onDelete={() => setDeleting(file)}
              />
            ))}
          </ul>
        )}
      </div>

      {data ? (
        <UploadModal
          projectId={projectId}
          knowledge={data}
          files={pending}
          onFilesChange={setPending}
          onUploaded={refresh}
        />
      ) : null}
      <EditModal
        projectId={projectId}
        file={editing}
        onClose={() => setEditing(null)}
        onSaved={refresh}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setDeleting(null);
        }}
        title={t('deleteDialog.title', { name: deleting ? knowledgeFileName(deleting.path) : '' })}
        description={t('deleteDialog.description')}
        confirmLabel={t('deleteDialog.confirm')}
        cancelLabel={t('cancel')}
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </CapabilityPageShell>
  );
}

function KnowledgeRow({
  file,
  canWrite,
  busy,
  onDownload,
  onEdit,
  onDelete,
}: {
  file: ProjectKnowledgeFile;
  canWrite: boolean;
  busy: boolean;
  onDownload: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('knowledge');
  return (
    <li className="flex items-center gap-3 px-4 py-2.5" data-testid="knowledge-row">
      <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-sm">
        <KnowledgeTypeIcon type={file.type} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-sm font-medium">{file.path}</p>
        <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
          <span className="shrink-0 uppercase">{file.type}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0 tabular-nums">{formatKnowledgeBytes(file.size)}</span>
          {file.description ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{file.description}</span>
            </>
          ) : null}
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" aria-label={t('actions', { name: file.path })}>
            {busy ? <Loading className="size-3.5 shrink-0" /> : <DotsThreeIcon className="size-4 shrink-0" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={onDownload}>
            <DownloadSimpleIcon className="size-3.5 shrink-0" />
            {t('download')}
          </DropdownMenuItem>
          {canWrite ? (
            <>
              <DropdownMenuItem onClick={onEdit}>
                <PencilSimpleIcon className="size-3.5 shrink-0" />
                {t('edit')}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <TrashIcon className="size-3.5 shrink-0" />
                {t('delete')}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function problemMessage(
  t: ReturnType<typeof useTranslations>,
  problem: UploadSelectionProblem,
  limits: ProjectKnowledge['limits'],
): string | null {
  switch (problem.kind) {
    case 'empty':
      return null;
    case 'too-many-files':
      return t('uploadModal.tooMany', { max: limits.max_upload_files });
    case 'file-too-large':
      return t('uploadModal.tooLarge', {
        name: problem.name,
        limit: formatKnowledgeBytes(limits.max_file_bytes),
      });
    case 'upload-too-large':
      return t('uploadModal.uploadTooLarge', { limit: formatKnowledgeBytes(limits.max_upload_bytes) });
    case 'project-full':
      return t('uploadModal.projectFull', { limit: formatKnowledgeBytes(limits.max_total_bytes) });
  }
}

function UploadModal({
  projectId,
  knowledge,
  files,
  onFilesChange,
  onUploaded,
}: {
  projectId: string;
  knowledge: ProjectKnowledge;
  files: File[] | null;
  onFilesChange: (files: File[] | null) => void;
  onUploaded: () => void;
}) {
  const t = useTranslations('knowledge');
  const [folder, setFolder] = useState('');
  const [description, setDescription] = useState('');
  const [replace, setReplace] = useState(false);

  const reset = () => {
    setFolder('');
    setDescription('');
    setReplace(false);
  };

  const upload = useMutation({
    mutationFn: (selection: File[]) =>
      uploadProjectKnowledge(projectId, selection, {
        folder: folder.trim() || undefined,
        description: description.trim() || undefined,
        replace,
      }),
    onSuccess: (result) => {
      successToast(t('toast.uploaded', { count: result.files.length }));
      onFilesChange(null);
      reset();
      onUploaded();
    },
    onError: (error: Error) => errorToast(error.message),
  });

  // While the modal animates closed `files` is already null. Keep showing the
  // last selection so the title does not flash "Upload 0 documents".
  const [shown, setShown] = useState<File[]>([]);
  if (files !== null && files !== shown) setShown(files);
  const selection = files ?? shown;
  const problem = checkUploadSelection(selection, knowledge.limits, knowledge.total_bytes);
  const message = problem ? problemMessage(t, problem, knowledge.limits) : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (problem || upload.isPending) return;
    upload.mutate(selection);
  };

  return (
    <Modal
      open={files !== null}
      onOpenChange={(open) => {
        if (upload.isPending) return;
        if (!open) {
          onFilesChange(null);
          reset();
        }
      }}
    >
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('uploadModal.title', { count: selection.length })}</ModalTitle>
          <ModalDescription>{t('uploadModal.description')}</ModalDescription>
        </ModalHeader>
        <form onSubmit={submit} autoComplete="off">
          <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
            <ul className={LIST_CLASS} data-testid="knowledge-upload-selection">
              {selection.map((file, index) => (
                <li key={`${file.name}-${index}`} className="flex items-center gap-3 px-4 py-2">
                  <span className="text-foreground min-w-0 flex-1 truncate text-sm">{file.name}</span>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {formatKnowledgeBytes(file.size)}
                  </span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t('uploadModal.removeFile', { name: file.name })}
                    disabled={upload.isPending}
                    onClick={() => {
                      const next = selection.filter((_, i) => i !== index);
                      onFilesChange(next.length > 0 ? next : null);
                    }}
                  >
                    <XIcon className="size-3.5 shrink-0" />
                  </Button>
                </li>
              ))}
            </ul>
            {message ? (
              <p className="text-kortix-red text-xs" role="alert">
                {message}
              </p>
            ) : null}
            <Field>
              <FieldLabel htmlFor="knowledge-upload-folder">{t('uploadModal.folder')}</FieldLabel>
              <Input
                id="knowledge-upload-folder"
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
                placeholder={t('uploadModal.folderPlaceholder')}
                className="font-mono"
                disabled={upload.isPending}
              />
              <FieldDescription>{t('uploadModal.folderHint')}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="knowledge-upload-description">
                {t('uploadModal.descriptionLabel')}
              </FieldLabel>
              <Input
                id="knowledge-upload-description"
                value={description}
                maxLength={280}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t('uploadModal.descriptionPlaceholder')}
                disabled={upload.isPending}
              />
              <FieldDescription>{t('uploadModal.descriptionHint')}</FieldDescription>
            </Field>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={replace}
                onCheckedChange={(checked) => setReplace(checked === true)}
                disabled={upload.isPending}
              />
              {t('uploadModal.replace')}
            </label>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline-ghost"
              size="sm"
              className="w-full sm:w-auto"
              disabled={upload.isPending}
              onClick={() => {
                onFilesChange(null);
                reset();
              }}
            >
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              className="w-full gap-1.5 sm:w-auto"
              disabled={problem !== null || upload.isPending}
            >
              {upload.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {t('uploadModal.submit')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}

function EditModal({
  projectId,
  file,
  onClose,
  onSaved,
}: {
  projectId: string;
  file: ProjectKnowledgeFile | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('knowledge');
  // Keyed on the path so opening another file starts from that file's values.
  return (
    <Modal
      open={file !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {file ? (
        <EditForm
          key={file.path}
          projectId={projectId}
          file={file}
          onClose={onClose}
          onSaved={onSaved}
          title={t('editModal.title')}
        />
      ) : null}
    </Modal>
  );
}

function EditForm({
  projectId,
  file,
  onClose,
  onSaved,
  title,
}: {
  projectId: string;
  file: ProjectKnowledgeFile;
  onClose: () => void;
  onSaved: () => void;
  title: string;
}) {
  const t = useTranslations('knowledge');
  const [path, setPath] = useState(file.path);
  const [description, setDescription] = useState(file.description ?? '');
  const nextPath = path.trim();
  const nextDescription = description.trim();
  const changed = nextPath !== file.path || nextDescription !== (file.description ?? '');

  const save = useMutation({
    mutationFn: () =>
      updateProjectKnowledgeFile(projectId, {
        path: file.path,
        newPath: nextPath !== file.path ? nextPath : undefined,
        description:
          nextDescription !== (file.description ?? '') ? nextDescription || null : undefined,
      }),
    onSuccess: () => {
      successToast(t('toast.updated'));
      onSaved();
      onClose();
    },
    onError: (error: Error) => errorToast(error.message),
  });

  return (
    <ModalContent className="lg:max-w-lg">
      <ModalHeader>
        <ModalTitle>{title}</ModalTitle>
        <ModalDescription>{t('editModal.description')}</ModalDescription>
      </ModalHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (changed && nextPath && !save.isPending) save.mutate();
        }}
        autoComplete="off"
      >
        <ModalBody className="space-y-4">
          <Field>
            <FieldLabel htmlFor="knowledge-edit-path">{t('editModal.path')}</FieldLabel>
            <Input
              id="knowledge-edit-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              className="font-mono"
              disabled={save.isPending}
            />
            <FieldDescription>{t('editModal.pathHint')}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="knowledge-edit-description">
              {t('uploadModal.descriptionLabel')}
            </FieldLabel>
            <Input
              id="knowledge-edit-description"
              value={description}
              maxLength={280}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t('uploadModal.descriptionPlaceholder')}
              disabled={save.isPending}
            />
          </Field>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline-ghost"
            size="sm"
            className="w-full sm:w-auto"
            disabled={save.isPending}
            onClick={onClose}
          >
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            size="sm"
            className="w-full gap-1.5 sm:w-auto"
            disabled={!changed || !nextPath || save.isPending}
          >
            {save.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {t('editModal.save')}
          </Button>
        </ModalFooter>
      </form>
    </ModalContent>
  );
}
