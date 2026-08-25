import React, { useEffect, useMemo, useState } from 'react'
import type { SupervisionSnapshot } from '@shared/supervision'
import type { LabAssistantSnapshot, LabAssistantTaskStatus } from '@shared/lab-assistant'
import { appStore, useStore } from '../state/AppState'
import { OpenCode } from '../lib/opencode'
import { projectName } from '../lib/project-name'

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export function LabAssistantPage(): React.JSX.Element {
  const projects = useStore(appStore, (state) => state.projects)
  const currentProjectPath = useStore(appStore, (state) => state.projectPath)
  const [snapshot, setSnapshot] = useState<SupervisionSnapshot | null>(null)
  const [assistant, setAssistant] = useState<LabAssistantSnapshot | null>(null)
  const [assistantError, setAssistantError] = useState('')
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [newTaskProject, setNewTaskProject] = useState('')
  const [newTaskDependency, setNewTaskDependency] = useState('')

  useEffect(() => {
    let disposed = false
    const refresh = (): void => {
      void OpenCode.supervision().then((value) => {
        if (!disposed) setSnapshot(value)
      }).catch(() => {})
      void OpenCode.labAssistant().then((value) => {
        if (!disposed) setAssistant(value)
      }).catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, 5_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [])

  const openQuestions = assistant?.questions.filter((question) => question.status === 'open') ?? []
  const tasks = useMemo(() => [...(assistant?.tasks ?? [])].sort((a, b) => {
    const rank: Record<LabAssistantTaskStatus, number> = { running: 0, review: 1, ready: 2, blocked: 3, inbox: 4, done: 5 }
    return rank[a.status] - rank[b.status] || b.updatedAt - a.updatedAt
  }), [assistant])
  const activeTasks = tasks.filter((task) => task.status !== 'done')
  const projectPaths = [...new Set([
    currentProjectPath,
    ...projects.map((project) => project.path || project.directory || project.worktree || ''),
    ...(snapshot?.threads ?? []).map((thread) => thread.projectPath)
  ].filter(Boolean))].sort()

  const createTask = (event: React.FormEvent): void => {
    event.preventDefault()
    const title = newTaskTitle.trim()
    if (!title) return
    setAssistantError('')
    void OpenCode.createLabAssistantTask({
      title,
      ...(newTaskProject ? { projectPath: newTaskProject } : {}),
      ...(newTaskDependency ? { dependsOn: [newTaskDependency] } : {})
    }).then((value) => {
      setAssistant(value)
      setNewTaskTitle('')
      setNewTaskDependency('')
    }).catch((error: unknown) => {
      setAssistantError(error instanceof Error ? error.message : 'The Lab Assistant could not create that task.')
    })
  }
  const updateTask = (taskId: string, status: 'ready' | 'review' | 'done'): void => {
    setAssistantError('')
    void OpenCode.updateLabAssistantTask(taskId, { status }).then(setAssistant).catch((error: unknown) => {
      setAssistantError(error instanceof Error ? error.message : 'The Lab Assistant could not update that task.')
    })
  }
  const assignTask = (taskId: string, threadId: string): void => {
    if (!threadId) return
    setAssistantError('')
    void OpenCode.assignLabAssistantTask(taskId, threadId).then(setAssistant).catch((error: unknown) => {
      setAssistantError(error instanceof Error ? error.message : 'The Lab Assistant could not assign that task.')
    })
  }
  const answerQuestion = (questionId: string, answerId: string): void => {
    setAssistantError('')
    void OpenCode.answerLabAssistant(questionId, answerId).then(setAssistant).catch((error: unknown) => {
      setAssistantError(error instanceof Error ? error.message : 'The Lab Assistant could not record that decision.')
    })
  }

  return (
    <div className="product-page lab-assistant-page">
      <header className="product-header">
        <div>
          <span className="product-eyebrow">Orchestration</span>
          <h1>Lab Assistant</h1>
          <p>Plan work across projects, resolve dependencies, and hand ready tasks to the right agent.</p>
        </div>
        <div className="lab-assistant-counts">
          <strong>{activeTasks.length}</strong><span>active tasks</span>
          <strong>{openQuestions.length}</strong><span>open decisions</span>
        </div>
      </header>

      {assistantError ? <div className="lab-assistant-error" role="alert">{assistantError}</div> : null}

      <div className="lab-assistant-layout">
        <main>
          <section className="product-section" aria-label="Lab Assistant decisions">
            <div className="product-section-head">
              <div><h2>Decisions</h2><p>Questions that block ordering or execution.</p></div>
              <span>{openQuestions.length}</span>
            </div>
            <div className="lab-decision-list">
              {openQuestions.map((question) => (
                <article className="lab-decision" key={question.id}>
                  <div>
                    <strong>{question.prompt}</strong>
                    <small>{question.repository}</small>
                  </div>
                  <div className="lab-decision-options">
                    {question.options.map((option) => (
                      <button key={option.id} onClick={() => answerQuestion(question.id, option.id)}>{option.label}</button>
                    ))}
                  </div>
                </article>
              ))}
              {openQuestions.length === 0 ? (
                <div className="product-empty lab-quiet">
                  <strong>Nothing needs a decision.</strong>
                  <span>{assistant?.activities[0]?.detail ?? 'New orchestration decisions will appear here.'}</span>
                </div>
              ) : null}
            </div>
          </section>

          <section className="product-section" aria-label="Lab Assistant tasks">
            <div className="product-section-head">
              <div><h2>Task queue</h2><p>Global and project work, ordered by readiness.</p></div>
              <span>{tasks.length}</span>
            </div>
            <form className="lab-task-form" onSubmit={createTask}>
              <input
                aria-label="New Lab Assistant task"
                value={newTaskTitle}
                onChange={(event) => setNewTaskTitle(event.target.value)}
                placeholder="What should happen next?"
              />
              <select aria-label="Task project" value={newTaskProject} onChange={(event) => setNewTaskProject(event.target.value)}>
                <option value="">Global</option>
                {projectPaths.map((path) => <option key={path} value={path}>{projectName(path)}</option>)}
              </select>
              <select aria-label="Task dependency" value={newTaskDependency} onChange={(event) => setNewTaskDependency(event.target.value)}>
                <option value="">No dependency</option>
                {tasks.filter((task) => task.status !== 'done').map((task) => (
                  <option key={task.id} value={task.id}>After {task.title}</option>
                ))}
              </select>
              <button type="submit" disabled={!newTaskTitle.trim()}>Add task</button>
            </form>
            <div className="lab-task-list">
              {tasks.map((task) => {
                const dependencyNames = task.dependsOn
                  .map((id) => tasks.find((candidate) => candidate.id === id)?.title)
                  .filter(Boolean)
                  .join(', ')
                const eligibleThreads = (snapshot?.threads ?? []).filter((thread) => !task.projectPath || thread.projectPath === task.projectPath)
                const assignedThread = (snapshot?.threads ?? []).find((thread) => thread.threadId === task.assignedThreadId)
                return (
                  <article className={`lab-task ${task.status}`} key={task.id}>
                    <span className="lab-task-state">{task.status}</span>
                    <div className="lab-task-copy">
                      <strong>{task.title}</strong>
                      <small>{task.projectPath ? projectName(task.projectPath) : 'Global'}{dependencyNames ? ` · after ${dependencyNames}` : ''}{assignedThread ? ` · ${assignedThread.title}` : ''}</small>
                    </div>
                    <div className="lab-task-actions">
                      {task.status === 'ready' ? (
                        <select aria-label={`Assign ${task.title}`} value="" onChange={(event) => assignTask(task.id, event.target.value)}>
                          <option value="">Assign agent…</option>
                          {eligibleThreads.map((thread) => <option key={thread.threadId} value={thread.threadId}>{thread.title}</option>)}
                        </select>
                      ) : null}
                      {task.status === 'running' ? <button type="button" onClick={() => updateTask(task.id, 'review')}>Ready for review</button> : null}
                      {task.status === 'review' ? <button type="button" onClick={() => updateTask(task.id, 'done')}>Complete</button> : null}
                      {task.status === 'ready' || task.status === 'blocked' || task.status === 'inbox'
                        ? <button type="button" aria-label={`Complete task: ${task.title}`} onClick={() => updateTask(task.id, 'done')}>Mark done</button>
                        : null}
                    </div>
                  </article>
                )
              })}
              {tasks.length === 0 ? <div className="product-empty">No tasks yet.</div> : null}
            </div>
          </section>
        </main>

        <aside>
          <section className="product-section lab-activity">
            <div className="product-section-head"><h2>Recent activity</h2></div>
            <div className="lab-activity-list">
              {(assistant?.activities ?? []).slice(0, 10).map((activity) => (
                <article key={activity.id}>
                  <strong>{activity.title}</strong>
                  <p>{activity.detail}</p>
                  <small>{activity.repository ? `${activity.repository} · ` : ''}{timeAgo(activity.createdAt)}</small>
                </article>
              ))}
              {assistant && assistant.activities.length === 0 ? <div className="product-empty">No activity yet.</div> : null}
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}
