use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub enum DistributorInstruction {
    /// Accounts: [payer(signer,writable), distributor_state(writable),
    ///            root_setter, dwell_mint, system_program]
    Initialize,
    /// Accounts: [root_setter(signer), distributor_state(writable)]
    /// `new_epoch` must equal `epoch + 1` — no replays or rollbacks.
    SetRoot { root: [u8; 32], new_epoch: u64, total_newly_allocated: u64 },
    /// Accounts: [owner(signer), distributor_state(writable)]
    SetRootSetter { root_setter: [u8; 32] },
    /// Accounts: [owner(signer), distributor_state(writable)]
    Pause,
    /// Accounts: [owner(signer), distributor_state(writable)]
    Unpause,
    /// Accounts: [payer(signer,writable), distributor_state(writable),
    ///            claim_status(writable), wallet, vault_authority,
    ///            vault(writable), wallet_dwell_account(writable),
    ///            token_program, system_program]
    /// Anyone may pay/execute for any wallet (gas sponsorship), but funds
    /// only ever go to the leaf wallet's token account.
    Claim { cumulative_amount: u64, proof: Vec<[u8; 32]> },
}
