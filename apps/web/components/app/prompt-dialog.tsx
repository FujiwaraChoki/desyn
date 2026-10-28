"use client";

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from "@desyn/ui";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Rich } from "@/components/rich";
import { errorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";

export interface PromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  label: string;
  placeholder?: string;
  initialValue?: string;
  submitLabel: string;
  maxLength?: number;
  /** Resolve to close; throw to show the error inline. */
  onSubmit: (value: string) => Promise<void> | void;
}

/** A one-field dialog (name a folder, rename a design, create a workspace). */
export function PromptDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  placeholder,
  initialValue = "",
  submitLabel,
  maxLength = 120,
  onSubmit,
}: PromptDialogProps) {
  const t = useT();
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setError(undefined);
    }
  }, [open, initialValue]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError(t("common.required"));
      return;
    }
    setPending(true);
    try {
      await onSubmit(trimmed);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="rich-title">
              <Rich text={title} />
            </DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <DialogBody className="pb-5">
            <Field label={label} error={error}>
              <Input
                autoFocus
                value={value}
                maxLength={maxLength}
                placeholder={placeholder}
                onChange={(e) => setValue(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
