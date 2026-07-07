use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub enum SwapInstruction {
    /// Accounts: [payer(signer,writable), swap_state(writable), dwell_mint, usdc_mint, system_program]
    Initialize { rate: u64 },
    /// Accounts: [authority(signer), swap_state(writable)]
    SetRate { rate: u64 },
    /// Accounts: [swap_state, vault_authority, router_dwell_vault(writable),
    ///            destination_dwell_account(writable), token_program]
    Swap { usdc_in: u64 },
}
