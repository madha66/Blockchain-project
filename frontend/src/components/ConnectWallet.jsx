import React from 'react';

const ConnectWallet = ({ account, connectWallet }) => {
  return (
    <div className="connect-wallet">
      {account ? (
        <p>Connected: {account.slice(0, 6)}...{account.slice(-4)}</p>
      ) : (
        <button onClick={connectWallet}>Connect MetaMask</button>
      )}
    </div>
  );
};

export default ConnectWallet;
