/** The Hisaab mark: the red ledger book (bahi-khata) with the ₹ and a rising arrow. */
export function Logo({ className }: { className?: string }) {
  return <img src={`${import.meta.env.BASE_URL}logo-mark.png`} alt="Hisaab" className={className} draggable={false} />;
}
