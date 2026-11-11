/** R3-FE-4b: typed cs/en copy for edits inside the authorized detail. Both tables keep the same
 * key set (tested). Calm, plain wording: a conflict says "changed elsewhere" and keeps the
 * user's own text; an uncertain write says what is known and what is not; nothing here names
 * ids, revisions, status codes or other people. */
import type {WriteFailure,WriteKind} from "./target-detail-write";
import type {DetailLanguage} from "./target-detail-copy";

export type EditCopy={
  readOnly:string;
  checking:string;
  offline:string;
  offlineBlocked:string;
  editTitle:string;
  editNote:string;
  titleLabel:string;
  bodyLabel:string;
  save:string;
  cancel:string;
  complete:string;
  restore:string;
  whenGroup:string;
  whenToday:string;
  whenTomorrow:string;
  deleteTask:string;
  deleteNote:string;
  confirmDeleteTask:(title:string)=>string;
  confirmDeleteNote:(title:string)=>string;
  confirmDelete:string;
  confirmCancel:string;
  undo:string;
  dismiss:string;
  titleEmpty:string;
  titleTooLong:string;
  bodyTooLong:string;
  unchanged:string;
  pending:Record<WriteKind,string>;
  committed:Record<WriteKind,string>;
  undone:Record<WriteKind,string>;
  /** Shown when a write finished but the item changed meanwhile. */
  conflict:string;
  conflictDraft:string;
  conflictReuse:string;
  conflictDiscard:string;
  uncertain:string;
  uncertainCheck:string;
  uncertainChecking:string;
  uncertainNotRecorded:string;
  uncertainBlocked:string;
  errors:Record<WriteFailure,string>;
  deletedTask:string;
  deletedNote:string;
  closeAfterDelete:string;
};

const kinds=(cs:Record<WriteKind,string>)=>cs;

export const editCopy:Record<DetailLanguage,EditCopy>={
  cs:{
    readOnly:"Tuto položku můžete jen číst.",
    checking:"Ověřuji, zda ji můžete upravit…",
    offline:"Jste offline. Úpravy jsou vypnuté a nic se neodesílá.",
    offlineBlocked:"Změna nebyla odeslána, protože nejste online. Napsaný text zůstal zachován.",
    editTitle:"Upravit název",
    editNote:"Upravit poznámku",
    titleLabel:"Název",
    bodyLabel:"Text poznámky",
    save:"Uložit",
    cancel:"Zrušit úpravu",
    complete:"Dokončit úkol",
    restore:"Obnovit úkol",
    whenGroup:"Kdy to udělám",
    whenToday:"Dnes",
    whenTomorrow:"Zítra",
    deleteTask:"Smazat úkol",
    deleteNote:"Smazat poznámku",
    confirmDeleteTask:title=>`Smazat úkol „${title}“? Tuto změnu nelze vrátit zpět.`,
    confirmDeleteNote:title=>`Smazat poznámku „${title}“? Tuto změnu nelze vrátit zpět.`,
    confirmDelete:"Ano, smazat",
    confirmCancel:"Nemazat",
    undo:"Vrátit zpět",
    dismiss:"Skrýt zprávu",
    titleEmpty:"Název nesmí být prázdný.",
    titleTooLong:"Název je příliš dlouhý.",
    bodyTooLong:"Text je příliš dlouhý.",
    unchanged:"Nic se nezměnilo.",
    pending:kinds({
      taskTitle:"Ukládám název…",taskStatus:"Ukládám stav úkolu…",taskWhen:"Ukládám, kdy úkol uděláte…",
      taskDelete:"Mažu úkol…",noteEdit:"Ukládám poznámku…",noteDelete:"Mažu poznámku…",
    }),
    committed:kinds({
      taskTitle:"Název je uložen.",taskStatus:"Stav úkolu je uložen.",taskWhen:"Termín „Kdy“ je uložen.",
      taskDelete:"Úkol je smazán.",noteEdit:"Poznámka je uložena.",noteDelete:"Poznámka je smazána.",
    }),
    undone:kinds({
      taskTitle:"Původní název je vrácen.",taskStatus:"Úkol je znovu otevřen.",taskWhen:"Původní „Kdy“ je vráceno.",
      taskDelete:"",noteEdit:"",noteDelete:"",
    }),
    conflict:"Položka se mezitím změnila jinde. Načetli jsme aktuální obsah a nic jsme nepřepsali.",
    conflictDraft:"Váš text, který se neuložil (můžete ho zkopírovat):",
    conflictReuse:"Upravit znovu nad aktuálním obsahem",
    conflictDiscard:"Zahodit můj text",
    uncertain:"Nevíme jistě, zda se změna uložila. Nic se neodesílá znovu, dokud to neověříte.",
    uncertainCheck:"Ověřit uložení",
    uncertainChecking:"Ověřuji uložení…",
    uncertainNotRecorded:"Server zatím žádné uložení nezaznamenal. To ještě neznamená, že se neuložilo; ověřte to za chvíli znovu.",
    uncertainBlocked:"Další změny jsou vypnuté, dokud se neověří předchozí.",
    errors:{
      invalid:"Změnu se nepodařilo odeslat, protože údaje neprošly kontrolou.",
      forbidden:"Tuto položku nelze upravit. Zobrazení je jen pro čtení.",
      unavailable:"Změnu se teď nepodařilo uložit. Nic se nezměnilo, zkuste to znovu.",
      "rate-limited":"Příliš mnoho požadavků. Nic se nezměnilo, zkuste to za chvíli.",
      "invalid-response":"Odpověď serveru neprošla kontrolou. Nic nebylo potvrzeno.",
    },
    deletedTask:"Úkol byl smazán a zmizel ze seznamů.",
    deletedNote:"Poznámka byla smazána a zmizela ze seznamů.",
    closeAfterDelete:"Zavřít",
  },
  en:{
    readOnly:"You can only read this item.",
    checking:"Checking whether you can edit it…",
    offline:"You are offline. Editing is off and nothing is sent.",
    offlineBlocked:"The change was not sent because you are offline. Your text was kept.",
    editTitle:"Edit title",
    editNote:"Edit note",
    titleLabel:"Title",
    bodyLabel:"Note text",
    save:"Save",
    cancel:"Cancel editing",
    complete:"Complete task",
    restore:"Restore task",
    whenGroup:"When I will do it",
    whenToday:"Today",
    whenTomorrow:"Tomorrow",
    deleteTask:"Delete task",
    deleteNote:"Delete note",
    confirmDeleteTask:title=>`Delete task “${title}”? This cannot be undone.`,
    confirmDeleteNote:title=>`Delete note “${title}”? This cannot be undone.`,
    confirmDelete:"Yes, delete",
    confirmCancel:"Do not delete",
    undo:"Undo",
    dismiss:"Dismiss message",
    titleEmpty:"The title cannot be empty.",
    titleTooLong:"The title is too long.",
    bodyTooLong:"The text is too long.",
    unchanged:"Nothing changed.",
    pending:kinds({
      taskTitle:"Saving the title…",taskStatus:"Saving the task status…",taskWhen:"Saving when you will do the task…",
      taskDelete:"Deleting the task…",noteEdit:"Saving the note…",noteDelete:"Deleting the note…",
    }),
    committed:kinds({
      taskTitle:"The title is saved.",taskStatus:"The task status is saved.",taskWhen:"“When” is saved.",
      taskDelete:"The task is deleted.",noteEdit:"The note is saved.",noteDelete:"The note is deleted.",
    }),
    undone:kinds({
      taskTitle:"The previous title is back.",taskStatus:"The task is open again.",taskWhen:"The previous “When” is back.",
      taskDelete:"",noteEdit:"",noteDelete:"",
    }),
    conflict:"The item changed elsewhere in the meantime. We loaded the current content and overwrote nothing.",
    conflictDraft:"Your text that was not saved (you can copy it):",
    conflictReuse:"Edit again on the current content",
    conflictDiscard:"Discard my text",
    uncertain:"We are not sure whether the change was saved. Nothing is sent again until you check.",
    uncertainCheck:"Check whether it was saved",
    uncertainChecking:"Checking…",
    uncertainNotRecorded:"The server has not recorded it yet. That does not mean it was not saved; check again in a moment.",
    uncertainBlocked:"Further changes are off until the previous one is checked.",
    errors:{
      invalid:"The change could not be sent because the values failed validation.",
      forbidden:"This item cannot be edited. The view is read-only.",
      unavailable:"The change could not be saved right now. Nothing changed; try again.",
      "rate-limited":"Too many requests. Nothing changed; try again in a moment.",
      "invalid-response":"The server response failed validation. Nothing was confirmed.",
    },
    deletedTask:"The task was deleted and has left the lists.",
    deletedNote:"The note was deleted and has left the lists.",
    closeAfterDelete:"Close",
  },
};
