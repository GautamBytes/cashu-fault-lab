import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EvidenceGallery } from './evidence-gallery';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  });
});

describe('EvidenceGallery', () => {
  it('exposes both screenshots as enlargement controls', () => {
    render(<EvidenceGallery />);

    expect(
      screen.getByRole('button', { name: 'Enlarge terminal verification screenshot' }),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Enlarge generated evidence report screenshot' }),
    ).toBeVisible();
  });

  it.each([
    {
      triggerName: 'Enlarge terminal verification screenshot',
      dialogName: 'Terminal verification output',
      imageName: /terminal showing the public doctor/i,
      imageSrc: '/evidence/v0.2.0-terminal.png',
    },
    {
      triggerName: 'Enlarge generated evidence report screenshot',
      dialogName: 'Generated evidence report',
      imageName: /generated evidence report showing the passed response-loss scenario/i,
      imageSrc: '/evidence/v0.2.0-report.png',
    },
  ])(
    'opens $dialogName at full resolution',
    async ({ triggerName, dialogName, imageName, imageSrc }) => {
      const user = userEvent.setup();
      render(<EvidenceGallery />);
      const trigger = screen.getByRole('button', { name: triggerName });

      await user.click(trigger);

      const dialog = screen.getByRole('dialog', { name: dialogName });
      expect(dialog).toBeVisible();
      expect(within(dialog).getByRole('img', { name: imageName })).toHaveAttribute('src', imageSrc);
    },
  );

  it('closes through the close control, backdrop, and Escape while restoring focus', async () => {
    const user = userEvent.setup();
    render(<EvidenceGallery />);
    const trigger = screen.getByRole('button', {
      name: 'Enlarge generated evidence report screenshot',
    });

    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Close image preview' }));
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog);
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(trigger).toHaveFocus();
  });

  it('does not close when the image panel is clicked', async () => {
    const user = userEvent.setup();
    render(<EvidenceGallery />);
    await user.click(
      screen.getByRole('button', { name: 'Enlarge terminal verification screenshot' }),
    );
    const dialog = screen.getByRole('dialog');

    await user.click(within(dialog).getByTestId('evidence-dialog-panel'));

    expect(dialog).toHaveAttribute('open');
  });
});
