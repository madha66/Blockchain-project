/**
 * Delivery channel for third-party (platform) notices. The prototype never contacts anyone:
 * the default sender only reports that the notice was simulated, and "sent" means the notice
 * is stored in MongoDB and shown on the admin page. A real channel would implement send()
 * after a legal review (RBI digital lending directions, DPDP Act 2023).
 *
 * interface NoticeSender { name: string; send(notice): Promise<{ delivered: boolean, simulated: boolean }> }
 */
export const noopSender = {
  name: "noop",
  async send() {
    return { delivered: false, simulated: true };
  },
};
