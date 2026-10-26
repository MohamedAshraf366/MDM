import { useEffect, useState } from 'react';
import type {
  CategoryRule,
  FileCategory,
  RuleInput,
  SiteAction,
  SiteRule,
  SiteRuleInput
} from '../../shared/types';
import { useApp } from '../app/store';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  FileGlyph,
  IconButton,
  InlineNote,
  Modal,
  PageHeader,
  Select,
  Tabs,
  TextInput,
  Toggle
} from '../components/Ui';
import { Icon } from '../components/Icons';

const CATEGORIES: Array<{ value: FileCategory; label: string }> = [
  { value: 'video', label: 'Video' },
  { value: 'audio', label: 'Audio' },
  { value: 'documents', label: 'Documents' },
  { value: 'archives', label: 'Archives' },
  { value: 'images', label: 'Images' },
  { value: 'programs', label: 'Programs' },
  { value: 'other', label: 'Other' }
];

const SITE_ACTIONS: Array<{ value: SiteAction; label: string; description: string }> = [
  { value: 'auto', label: 'Download automatically', description: 'Queue matching browser captures without prompting.' },
  { value: 'ask', label: 'Ask first', description: 'Hold matching captures for review before they start.' },
  { value: 'ignore', label: 'Ignore', description: 'Reject matching captures from the browser bridge.' }
];

export function RulesPage() {
  const { snapshot, call, notify } = useApp();
  const [tab, setTab] = useState<'categories' | 'sites'>('categories');
  const [ruleEditor, setRuleEditor] = useState<CategoryRule | 'new' | null>(null);
  const [siteEditor, setSiteEditor] = useState<SiteRule | 'new' | null>(null);
  const [removeRule, setRemoveRule] = useState<CategoryRule | null>(null);
  const [removeSite, setRemoveSite] = useState<SiteRule | null>(null);
  const rules = snapshot?.rules.slice().sort((a, b) => b.priority - a.priority) ?? [];
  const siteRules = snapshot?.siteRules ?? [];

  const toggleRule = async (rule: CategoryRule) => {
    await call(
      window.mdm.saveRule({ ...toRuleInput(rule), enabled: !rule.enabled }),
      rule.enabled ? 'Rule disabled' : 'Rule enabled'
    );
  };

  const toggleSite = async (rule: SiteRule) => {
    await call(
      window.mdm.saveSiteRule({ ...toSiteInput(rule), enabled: !rule.enabled }),
      rule.enabled ? 'Site rule disabled' : 'Site rule enabled'
    );
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Automation"
        title="Rules"
        description="Route files into the right folders and control how browser captures are handled."
        actions={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => (tab === 'categories' ? setRuleEditor('new') : setSiteEditor('new'))}
          >
            {tab === 'categories' ? 'New category rule' : 'New site rule'}
          </Button>
        }
      />

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'categories', label: 'Category rules', count: rules.length },
          { value: 'sites', label: 'Site rules', count: siteRules.length }
        ]}
      />

      {tab === 'categories' ? (
        <div className="rules-layout">
          <div className="rules-main">
            {rules.length ? (
              <div className="rule-list">
                {rules.map((rule) => (
                  <article key={rule.id} className={`rule-card ${rule.enabled ? '' : 'is-disabled'}`.trim()}>
                    <div className="rule-icon">
                      <FileGlyph category={rule.category} />
                    </div>
                    <div className="rule-copy">
                      <div className="rule-title">
                        <h3>{rule.name}</h3>
                        <span className="rule-priority">Priority {rule.priority}</span>
                        {!rule.enabled ? <span className="mini-badge">Disabled</span> : null}
                      </div>
                      <p>
                        <span className="rule-match-type">{matchLabel(rule.matchType)}</span>
                        <code>{rule.pattern}</code>
                      </p>
                      <div className="rule-meta">
                        <span>
                          <Icon name="folder" size={13} />
                          {rule.destinationDir || `Category folder · ${snapshot?.settings.categoryFolders[rule.category] ?? rule.category}`}
                        </span>
                        {rule.autoOpen ? (
                          <span>
                            <Icon name="external" size={13} />
                            Opens when complete
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="rule-actions">
                      <Toggle checked={rule.enabled} onChange={() => void toggleRule(rule)} label={`Enable ${rule.name}`} />
                      <IconButton icon="edit" label="Edit rule" onClick={() => setRuleEditor(rule)} />
                      <IconButton icon="trash" label="Delete rule" variant="danger" onClick={() => setRemoveRule(rule)} />
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <Card>
                <EmptyState
                  icon="rules"
                  title="No category rules"
                  description="Add a rule to route specific file types or hosts into a folder."
                  action={
                    <Button variant="primary" icon="plus" onClick={() => setRuleEditor('new')}>
                      Create a rule
                    </Button>
                  }
                />
              </Card>
            )}
          </div>
          <aside className="rules-aside">
            <Card title="Rule order" subtitle="First enabled match wins.">
              <ol className="rule-order">
                {rules.filter((rule) => rule.enabled).slice(0, 7).map((rule) => (
                  <li key={rule.id}>
                    <span>{rule.name}</span>
                    <small>{rule.priority}</small>
                  </li>
                ))}
              </ol>
              {!rules.some((rule) => rule.enabled) ? <p className="muted">No enabled rules. Downloads use category folders.</p> : null}
            </Card>
            <Card title="Folder strategy">
              <p className="aside-copy">
                Category folders keep downloads organized automatically. Set a folder on a rule to override the
                default for that category.
              </p>
            </Card>
          </aside>
        </div>
      ) : (
        <div className="rules-layout">
          <div className="rules-main">
            {siteRules.length ? (
              <div className="rule-list">
                {siteRules.map((rule) => (
                  <article key={rule.id} className={`rule-card site-rule ${rule.enabled ? '' : 'is-disabled'}`.trim()}>
                    <div className="rule-icon site-rule-icon">
                      <Icon name="globe" size={20} />
                    </div>
                    <div className="rule-copy">
                      <div className="rule-title">
                        <h3>{rule.name}</h3>
                        <span className={`site-action site-action-${rule.action}`}>
                          {SITE_ACTIONS.find((action) => action.value === rule.action)?.label ?? rule.action}
                        </span>
                        {!rule.enabled ? <span className="mini-badge">Disabled</span> : null}
                      </div>
                      <p>
                        <span className="rule-match-type">Site</span>
                        <code>{rule.pattern}</code>
                      </p>
                      <div className="rule-meta">
                        <span>
                          <Icon name="file" size={13} />
                          {rule.fileTypes.length ? rule.fileTypes.map((type) => `.${type}`).join(', ') : 'All file types'}
                        </span>
                        {rule.destinationDir ? (
                          <span>
                            <Icon name="folder" size={13} />
                            {rule.destinationDir}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="rule-actions">
                      <Toggle checked={rule.enabled} onChange={() => void toggleSite(rule)} label={`Enable ${rule.name}`} />
                      <IconButton icon="edit" label="Edit site rule" onClick={() => setSiteEditor(rule)} />
                      <IconButton icon="trash" label="Delete site rule" variant="danger" onClick={() => setRemoveSite(rule)} />
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <Card>
                <EmptyState
                  icon="globe"
                  title="No site rules"
                  description="Site rules let you auto-capture, review, or ignore downloads from specific websites."
                  action={
                    <Button variant="primary" icon="plus" onClick={() => setSiteEditor('new')}>
                      Create a site rule
                    </Button>
                  }
                />
              </Card>
            )}
          </div>
          <aside className="rules-aside">
            <Card title="Browser capture">
              <p className="aside-copy">
                Site patterns accept wildcards, for example <code>*.example.com</code>. The most specific matching
                pattern wins.
              </p>
              <InlineNote tone="info">Site rules apply to links sent by the MDM browser extension.</InlineNote>
              <Button size="sm" icon="puzzle" onClick={() => window.mdm.openExtensionFolder().then((result) => {
                if (!result.ok) notify('error', 'Could not open extension folder', result.error);
              })}>
                Open extension folder
              </Button>
            </Card>
          </aside>
        </div>
      )}

      <CategoryRuleEditor target={ruleEditor} onClose={() => setRuleEditor(null)} />
      <SiteRuleEditor target={siteEditor} onClose={() => setSiteEditor(null)} />

      <ConfirmDialog
        open={Boolean(removeRule)}
        title="Delete category rule?"
        message={`"${removeRule?.name ?? ''}" will stop routing new downloads.`}
        confirmLabel="Delete rule"
        danger
        onCancel={() => setRemoveRule(null)}
        onConfirm={() => {
          const target = removeRule;
          setRemoveRule(null);
          if (target) void call(window.mdm.deleteRule(target.id), 'Rule deleted');
        }}
      />
      <ConfirmDialog
        open={Boolean(removeSite)}
        title="Delete site rule?"
        message={`"${removeSite?.name ?? ''}" will no longer affect browser captures from this site.`}
        confirmLabel="Delete site rule"
        danger
        onCancel={() => setRemoveSite(null)}
        onConfirm={() => {
          const target = removeSite;
          setRemoveSite(null);
          if (target) void call(window.mdm.deleteSiteRule(target.id), 'Site rule deleted');
        }}
      />
    </div>
  );
}

function CategoryRuleEditor({ target, onClose }: { target: CategoryRule | 'new' | null; onClose: () => void }) {
  const { snapshot, notify } = useApp();
  const [name, setName] = useState('');
  const [matchType, setMatchType] = useState<RuleInput['matchType']>('extension');
  const [pattern, setPattern] = useState('');
  const [category, setCategory] = useState<FileCategory>('other');
  const [destination, setDestination] = useState('');
  const [priority, setPriority] = useState('50');
  const [autoOpen, setAutoOpen] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!target) return;
    setError('');
    if (target === 'new') {
      setName('');
      setMatchType('extension');
      setPattern('');
      setCategory('other');
      setDestination('');
      setPriority('50');
      setAutoOpen(false);
      setEnabled(true);
    } else {
      setName(target.name);
      setMatchType(target.matchType);
      setPattern(target.pattern);
      setCategory(target.category);
      setDestination(target.destinationDir);
      setPriority(String(target.priority));
      setAutoOpen(target.autoOpen);
      setEnabled(target.enabled);
    }
  }, [target]);

  const chooseFolder = async () => {
    const result = await window.mdm.chooseFolder(destination || snapshot?.settings.defaultDownloadDir);
    if (result.ok && result.data) setDestination(result.data);
  };

  const save = async () => {
    setError('');
    if (!name.trim() || !pattern.trim()) {
      setError('A name and match pattern are required.');
      return;
    }
    setSaving(true);
    try {
      const input: RuleInput = {
        name: name.trim(),
        matchType,
        pattern: pattern.trim(),
        category,
        destinationDir: destination.trim(),
        priority: Number(priority) || 0,
        autoOpen,
        enabled
      };
      if (target && target !== 'new') input.id = target.id;
      const result = await window.mdm.saveRule(input);
      if (!result.ok) throw new Error(result.error ?? 'The rule could not be saved.');
      notify('success', target === 'new' ? 'Rule created' : 'Rule updated');
      onClose();
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const placeholder =
    matchType === 'extension' ? 'mp4,mkv,webm' : matchType === 'mime' ? 'video/mp4' : '*.example.com';

  return (
    <Modal
      open={Boolean(target)}
      onClose={onClose}
      title={target === 'new' ? 'New category rule' : 'Edit category rule'}
      subtitle="Rules are matched against the final file name, MIME type, or host."
      width={620}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="check" loading={saving} onClick={() => void save()}>
            Save rule
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Rule name" className="span-2">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Course videos" />
        </Field>
        <Field label="Match type">
          <Select value={matchType} onChange={(event) => setMatchType(event.target.value as RuleInput['matchType'])}>
            <option value="extension">File extension</option>
            <option value="mime">MIME type</option>
            <option value="host">Website host</option>
          </Select>
        </Field>
        <Field label="Priority" hint="Higher priority is checked first.">
          <TextInput type="number" value={priority} onChange={(event) => setPriority(event.target.value)} />
        </Field>
        <Field
          label="Pattern"
          className="span-2"
          hint={
            matchType === 'extension'
              ? 'Comma-separated extensions, wildcards allowed.'
              : matchType === 'mime'
                ? 'Exact MIME type or wildcard such as video/*.'
                : 'Comma-separated hosts, wildcards allowed.'
          }
        >
          <TextInput value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder={placeholder} />
        </Field>
        <Field label="Category">
          <Select value={category} onChange={(event) => setCategory(event.target.value as FileCategory)}>
            {CATEGORIES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Destination folder" hint="Leave blank to use the category folder.">
          <div className="input-row">
            <TextInput value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Automatic" />
            <Button icon="folder" onClick={() => void chooseFolder()}>
              Browse
            </Button>
          </div>
        </Field>
        <div className="setting-row span-2">
          <div>
            <strong>Open matching files</strong>
            <p>Only files that are safe to open are launched automatically.</p>
          </div>
          <Toggle checked={autoOpen} onChange={setAutoOpen} label="Open matching files" />
        </div>
        <div className="setting-row span-2">
          <div>
            <strong>Enable rule</strong>
            <p>Disabled rules are skipped when new downloads are added.</p>
          </div>
          <Toggle checked={enabled} onChange={setEnabled} label="Enable rule" />
        </div>
      </div>
      {error ? <InlineNote tone="danger">{error}</InlineNote> : null}
    </Modal>
  );
}

function SiteRuleEditor({ target, onClose }: { target: SiteRule | 'new' | null; onClose: () => void }) {
  const { snapshot, notify } = useApp();
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [action, setAction] = useState<SiteAction>('auto');
  const [fileTypes, setFileTypes] = useState('');
  const [destination, setDestination] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!target) return;
    setError('');
    if (target === 'new') {
      setName('');
      setPattern('');
      setAction('auto');
      setFileTypes('');
      setDestination('');
      setEnabled(true);
    } else {
      setName(target.name);
      setPattern(target.pattern);
      setAction(target.action);
      setFileTypes(target.fileTypes.join(', '));
      setDestination(target.destinationDir);
      setEnabled(target.enabled);
    }
  }, [target]);

  const chooseFolder = async () => {
    const result = await window.mdm.chooseFolder(destination || snapshot?.settings.defaultDownloadDir);
    if (result.ok && result.data) setDestination(result.data);
  };

  const save = async () => {
    setError('');
    if (!name.trim() || !pattern.trim()) {
      setError('A name and site pattern are required.');
      return;
    }
    setSaving(true);
    try {
      const input: SiteRuleInput = {
        name: name.trim(),
        pattern: pattern.trim(),
        action,
        fileTypes: fileTypes
          .split(',')
          .map((type) => type.trim().replace(/^\./, '').toLowerCase())
          .filter(Boolean),
        destinationDir: destination.trim(),
        enabled
      };
      if (target && target !== 'new') input.id = target.id;
      const result = await window.mdm.saveSiteRule(input);
      if (!result.ok) throw new Error(result.error ?? 'The site rule could not be saved.');
      notify('success', target === 'new' ? 'Site rule created' : 'Site rule updated');
      onClose();
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const selectedAction = SITE_ACTIONS.find((item) => item.value === action);

  return (
    <Modal
      open={Boolean(target)}
      onClose={onClose}
      title={target === 'new' ? 'New site rule' : 'Edit site rule'}
      subtitle="Control what happens when this site sends a download to MDM."
      width={600}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="check" loading={saving} onClick={() => void save()}>
            Save site rule
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Rule name" className="span-2">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Training portal" />
        </Field>
        <Field label="Site pattern" className="span-2" hint="Host name with optional wildcards, e.g. *.example.com.">
          <TextInput value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder="*.example.com" />
        </Field>
        <Field label="Browser action" className="span-2" hint={selectedAction?.description}>
          <Select value={action} onChange={(event) => setAction(event.target.value as SiteAction)}>
            {SITE_ACTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="File types" className="span-2" hint="Comma-separated extensions. Leave blank for all files.">
          <TextInput value={fileTypes} onChange={(event) => setFileTypes(event.target.value)} placeholder="zip, pdf, mp4" />
        </Field>
        <Field label="Destination folder" className="span-2" hint="Optional. Blank uses normal category routing.">
          <div className="input-row">
            <TextInput value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Automatic" />
            <Button icon="folder" onClick={() => void chooseFolder()}>
              Browse
            </Button>
          </div>
        </Field>
        <div className="setting-row span-2">
          <div>
            <strong>Enable site rule</strong>
            <p>Disabled rules are skipped when a browser capture arrives.</p>
          </div>
          <Toggle checked={enabled} onChange={setEnabled} label="Enable site rule" />
        </div>
      </div>
      {action === 'ask' ? (
        <InlineNote tone="info">Matching captures will be held as paused downloads so you can review them before starting.</InlineNote>
      ) : null}
      {error ? <InlineNote tone="danger">{error}</InlineNote> : null}
    </Modal>
  );
}

function toRuleInput(rule: CategoryRule): RuleInput {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    priority: rule.priority,
    matchType: rule.matchType,
    pattern: rule.pattern,
    category: rule.category,
    destinationDir: rule.destinationDir,
    autoOpen: rule.autoOpen
  };
}

function toSiteInput(rule: SiteRule): SiteRuleInput {
  return {
    id: rule.id,
    name: rule.name,
    pattern: rule.pattern,
    action: rule.action,
    fileTypes: rule.fileTypes,
    destinationDir: rule.destinationDir,
    enabled: rule.enabled
  };
}

function matchLabel(matchType: CategoryRule['matchType']): string {
  return matchType === 'extension' ? 'Extensions' : matchType === 'mime' ? 'MIME' : 'Host';
}
