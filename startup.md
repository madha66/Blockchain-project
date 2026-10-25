npx hardhat node
npm run deploy:local
cd backend && npm run db:reset && npm run dev
cd backend && npm run seed:demo        (optional, needs the backend running)
npm run demo:scenarios                 (optional)
cd frontend && npm run dev
