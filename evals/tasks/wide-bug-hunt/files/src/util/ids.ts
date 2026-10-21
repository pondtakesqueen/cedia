let next = 1;
export const orderId = () => `o${String(next++).padStart(6, '0')}`;
