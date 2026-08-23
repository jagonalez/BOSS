import React from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { theme } from './theme'

export interface Todo {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

/** A changed file. `content` is present only for the file being viewed — the
 *  list carries counts alone, because whole files do not fit over the relay. */
export interface DiffFile {
  path: string
  status?: string
  additions?: number
  deletions?: number
  content?: string
  original?: string
}

function mark(status: Todo['status']): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '▸'
  if (status === 'cancelled') return '✕'
  return '·'
}

function tone(status: Todo['status']): string {
  if (status === 'completed') return theme.faint
  if (status === 'in_progress') return theme.green
  if (status === 'cancelled') return theme.faint
  return theme.muted
}

/**
 * What the agent is doing, and what it changed.
 *
 * Two questions a phone cannot otherwise answer: mid-run the transcript shows
 * tool calls but not the plan, and afterwards it says what happened but not
 * what the working tree now looks like.
 *
 * Diffs arrive in two steps. The list carries only paths and counts, and one
 * file's contents are fetched when it is opened, because a handful of edited
 * files in full exceeds the relay's frame cap — and unlike a transcript, a
 * diff cannot be trimmed without silently dropping files.
 */
export function WorkScreen({
  todos, files, openFile, fileBody, loading, loadingFile, onOpenFile, onCloseFile
}: {
  todos: Todo[]
  files: DiffFile[]
  openFile?: string
  fileBody?: DiffFile
  loading: boolean
  loadingFile: boolean
  onOpenFile(path: string): void
  onCloseFile(): void
}): React.JSX.Element {
  if (openFile) {
    return (
      <View style={styles.fill}>
        <View style={styles.fileBar}>
          <Pressable onPress={onCloseFile} hitSlop={8}>
            <Text style={styles.back}>‹ Changes</Text>
          </Pressable>
          <Text style={styles.filePath} numberOfLines={1}>{openFile.split('/').pop()}</Text>
        </View>
        {loadingFile ? (
          <ActivityIndicator color={theme.faint} style={styles.spinner} />
        ) : (
          <ScrollView horizontal>
            <ScrollView contentContainerStyle={styles.code}>
              <Text style={styles.codeText} selectable>
                {fileBody?.content ?? 'This file has no contents to show.'}
              </Text>
            </ScrollView>
          </ScrollView>
        )}
      </View>
    )
  }

  const active = todos.filter((t) => t.status !== 'cancelled')

  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.body}>
      {loading ? <ActivityIndicator color={theme.faint} style={styles.spinner} /> : null}

      {active.length ? (
        <>
          <Text style={styles.section}>Plan</Text>
          {active.map((todo) => (
            <View key={todo.id} style={styles.todo}>
              <Text style={[styles.mark, { color: tone(todo.status) }]}>{mark(todo.status)}</Text>
              <Text
                style={[
                  styles.todoText,
                  todo.status === 'completed' && styles.done
                ]}
              >
                {todo.content}
              </Text>
            </View>
          ))}
        </>
      ) : null}

      {files.length ? (
        <>
          <Text style={styles.section}>Changes</Text>
          {files.map((file) => (
            <Pressable key={file.path} style={styles.file} onPress={() => onOpenFile(file.path)}>
              <Text style={styles.path} numberOfLines={1} ellipsizeMode="head">{file.path}</Text>
              <View style={styles.counts}>
                {file.additions ? <Text style={styles.add}>+{file.additions}</Text> : null}
                {file.deletions ? <Text style={styles.del}>−{file.deletions}</Text> : null}
              </View>
            </Pressable>
          ))}
        </>
      ) : null}

      {!loading && !active.length && !files.length ? (
        <Text style={styles.empty}>Nothing planned and nothing changed yet.</Text>
      ) : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: theme.bg },
  body: { padding: 16, paddingBottom: 40 },
  section: { color: theme.muted, fontSize: 13, fontWeight: '700', marginTop: 8, marginBottom: 10 },
  todo: { flexDirection: 'row', gap: 10, marginBottom: 9 },
  mark: { fontSize: 14, width: 14 },
  todoText: { color: theme.text, fontSize: 14.5, flex: 1, lineHeight: 20 },
  done: { color: theme.faint, textDecorationLine: 'line-through' },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.line
  },
  path: { color: theme.text, fontSize: 14, flex: 1, marginRight: 10 },
  counts: { flexDirection: 'row', gap: 8 },
  add: { color: theme.green, fontSize: 13 },
  del: { color: theme.red, fontSize: 13 },
  fileBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.line
  },
  back: { color: theme.accent, fontSize: 15 },
  filePath: { color: theme.text, fontSize: 15, fontWeight: '600', flex: 1 },
  code: { padding: 14 },
  codeText: { color: theme.text, fontFamily: 'Menlo', fontSize: 11.5, lineHeight: 16 },
  spinner: { marginTop: 24 },
  empty: { color: theme.faint, textAlign: 'center', marginTop: 40 }
})
