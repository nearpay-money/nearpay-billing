-- spec 0.3.1 (lld/billing.md §13): per-subscription test-mode billing clock = now() + clock_offset_s.
-- Live subscriptions can never get an offset (check), and the offset only moves forward (check + trigger).
alter table subscriptions add column clock_offset_s bigint not null default 0;
alter table subscriptions add constraint subs_clock_test_only check (livemode = false or clock_offset_s = 0);
alter table subscriptions add constraint subs_clock_non_negative check (clock_offset_s >= 0);

create function billing_clock_forward_only() returns trigger language plpgsql as $$
begin
  if new.clock_offset_s < old.clock_offset_s then
    raise exception 'subscription % billing clock cannot move back', old.id;
  end if;
  return new;
end $$;
create trigger subs_clock_forward_only before update of clock_offset_s on subscriptions
  for each row execute function billing_clock_forward_only();

-- spec 0.3.1 InvoiceNotificationContext.destination_fingerprint: the fingerprint of the settlement
-- destination the paying intent settled to (payments' DestinationSnapshot), recorded when the invoice is paid.
alter table invoices add column destination_fingerprint text;
