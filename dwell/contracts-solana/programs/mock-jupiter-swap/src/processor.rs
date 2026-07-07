use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

use crate::error::SwapError;
use crate::instruction::SwapInstruction;
use crate::state::{SwapState, SWAP_STATE_SEED, VAULT_AUTHORITY_SEED};

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let ix = SwapInstruction::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)?;
    match ix {
        SwapInstruction::Initialize { rate } => initialize(program_id, accounts, rate),
        SwapInstruction::SetRate { rate } => set_rate(program_id, accounts, rate),
        SwapInstruction::Swap { usdc_in } => swap(program_id, accounts, usdc_in),
    }
}

fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], rate: u64) -> ProgramResult {
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let swap_state_ai = next_account_info(iter)?;
    let dwell_mint = next_account_info(iter)?;
    let usdc_mint = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let (expected_state, bump) = Pubkey::find_program_address(&[SWAP_STATE_SEED], program_id);
    if expected_state != *swap_state_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }
    if swap_state_ai.data_len() > 0 && !swap_state_ai.data.borrow().iter().all(|b| *b == 0) {
        return Err(SwapError::AlreadyInitialized.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(SwapState::LEN);
    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            swap_state_ai.key,
            lamports,
            SwapState::LEN as u64,
            program_id,
        ),
        &[payer.clone(), swap_state_ai.clone(), system_program.clone()],
        &[&[SWAP_STATE_SEED, &[bump]]],
    )?;

    let state = SwapState {
        is_initialized: true,
        authority: *payer.key,
        dwell_mint: *dwell_mint.key,
        usdc_mint: *usdc_mint.key,
        rate,
    };
    state.serialize(&mut &mut swap_state_ai.data.borrow_mut()[..])?;
    msg!("mock-jupiter-swap: initialized, rate={}", rate);
    Ok(())
}

fn set_rate(program_id: &Pubkey, accounts: &[AccountInfo], rate: u64) -> ProgramResult {
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let swap_state_ai = next_account_info(iter)?;

    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (expected_state, _bump) = Pubkey::find_program_address(&[SWAP_STATE_SEED], program_id);
    if expected_state != *swap_state_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }

    let mut state = SwapState::try_from_slice(&swap_state_ai.data.borrow())?;
    if !state.is_initialized {
        return Err(SwapError::NotInitialized.into());
    }
    if state.authority != *authority.key {
        return Err(SwapError::NotAuthority.into());
    }
    state.rate = rate;
    state.serialize(&mut &mut swap_state_ai.data.borrow_mut()[..])?;
    msg!("mock-jupiter-swap: rate updated to {}", rate);
    Ok(())
}

/// Pays out `usdc_in * rate / 1_000_000` DWELL from the router's own
/// pre-funded vault. Does not itself pull the USDC leg — the caller
/// (dwell-funder) performs that transfer in the same transaction, exactly
/// as a real Jupiter route would move the input token before this program
/// ever runs; this mock only stands in for the swap's output leg.
fn swap(program_id: &Pubkey, accounts: &[AccountInfo], usdc_in: u64) -> ProgramResult {
    let iter = &mut accounts.iter();
    let swap_state_ai = next_account_info(iter)?;
    let vault_authority_ai = next_account_info(iter)?;
    let router_dwell_vault = next_account_info(iter)?;
    let destination_dwell_account = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    let (expected_state, _) = Pubkey::find_program_address(&[SWAP_STATE_SEED], program_id);
    if expected_state != *swap_state_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }
    let (expected_vault_authority, vault_bump) =
        Pubkey::find_program_address(&[VAULT_AUTHORITY_SEED], program_id);
    if expected_vault_authority != *vault_authority_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }

    let state = SwapState::try_from_slice(&swap_state_ai.data.borrow())?;
    if !state.is_initialized {
        return Err(SwapError::NotInitialized.into());
    }

    let dwell_out = (usdc_in as u128)
        .checked_mul(state.rate as u128)
        .and_then(|v| v.checked_div(1_000_000))
        .ok_or(ProgramError::ArithmeticOverflow)? as u64;

    let vault_account = spl_token::state::Account::unpack(&router_dwell_vault.data.borrow())?;
    if vault_account.amount < dwell_out {
        return Err(SwapError::InsufficientVaultBalance.into());
    }

    invoke_signed(
        &spl_token::instruction::transfer(
            token_program.key,
            router_dwell_vault.key,
            destination_dwell_account.key,
            vault_authority_ai.key,
            &[],
            dwell_out,
        )?,
        &[
            router_dwell_vault.clone(),
            destination_dwell_account.clone(),
            vault_authority_ai.clone(),
            token_program.clone(),
        ],
        &[&[VAULT_AUTHORITY_SEED, &[vault_bump]]],
    )?;

    msg!("mock-jupiter-swap: swapped usdc_in={} dwell_out={}", usdc_in, dwell_out);
    Ok(())
}
