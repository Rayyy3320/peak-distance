// Pure mapping shared by IndexedDB queue validation and file synchronization.
import type { EntryView } from '@/shared/messages';
import type { ContextRecord, SavedSentence, VocabEntryRecord } from '@/shared/vocab';
import type { VaultVocabRecord, VaultSentenceRecord } from '@/shared/vault';

export function entryViewToVaultRecord(e: EntryView): VaultVocabRecord {
  return {
    id: e.key,
    language: e.language ?? 'und',
    expression: e.expression,
    status: e.status,
    forms: e.forms,
    note: e.note ?? '',
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    contexts: e.contexts.map((c) => ({
      sentence: c.sentence,
      url: c.url,
      title: c.title,
      sourceType: c.sourceType,
      video: c.video ?? null,
      createdAt: c.createdAt,
      definition: c.definition,
      ...(c.result ? { result: c.result } : {}),
      ...(c.explanation ? { explanation: c.explanation } : {}),
    })),
  };
}

export function vaultRecordToEntry(record: VaultVocabRecord, note: string): {
  entry: VocabEntryRecord;
  contexts: Omit<ContextRecord, 'id'>[];
} {
  return {
    entry: {
      key: record.id,
      language: record.language,
      expression: record.expression,
      kind: /\s/.test(record.expression.trim()) ? 'phrase' : 'word',
      status: record.status,
      ...(note ? { note } : {}),
      createdAt: record.createdAt || Date.now(),
      updatedAt: record.updatedAt || Date.now(),
      forms: record.forms?.length ? record.forms : undefined,
    },
    contexts: record.contexts.map((c) => ({
      entryKey: record.id,
      sentence: c.sentence,
      definition: c.definition ?? null,
      ...(c.result ? { result: c.result } : {}),
      ...(c.explanation ? { explanation: c.explanation } : {}),
      sourceType: c.sourceType,
      url: c.url,
      title: c.title,
      video: c.video ?? null,
      createdAt: c.createdAt || Date.now(),
    })),
  };
}

export function sentenceToVaultRecord(s: SavedSentence): VaultSentenceRecord {
  return {
    id: s.id,
    language: s.language ?? s.video.trackLang ?? 'und',
    text: s.text,
    ...(s.zh ? { translation: s.zh } : {}),
    ...(s.translationSource ? { translationSource: s.translationSource } : {}),
    video: s.video,
    endMs: s.endMs,
    title: s.title,
    createdAt: s.createdAt,
  };
}

